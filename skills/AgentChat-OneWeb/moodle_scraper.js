#!/usr/bin/env node
/**
 * Moodle Course Scraper — Single-pass CDP extraction for LMS assignments.
 *
 * Designed to be invoked by Claude Code as a fast pre-step before feeding
 * assignment data into AgentChat-IndependentTasks for multi-AI answering.
 *
 * Usage:
 *   node moodle_scraper.js [--course-url=https://lms.sysu.edu.cn/course/view.php?id=...]
 *                          [--max-detail=10] [--detail-timeout=8000]
 *
 * If --course-url is omitted, auto-discovers the first Moodle course tab
 * from the connected Chrome's open pages.
 *
 * Output: JSON array of assignment objects on stdout.
 *   { title, url, summary, detail?: { description, files, error? } }
 *
 * Exit codes: 0=success, 1=no CDP, 2=no course tab found, 3=all failed
 */

const { chromium } = require('playwright-core');

// ═══ CLI args ═══
const args = process.argv.slice(2);
function flag(name)       { const m = args.find(a => a.startsWith(`--${name}=`)); return m ? m.split('=')[1] : null; }
function hasFlag(name)    { return args.includes(`--${name}`); }

const COURSE_URL = flag('course-url');
const MAX_DETAIL  = parseInt(flag('max-detail') || '12', 10);
const DETAIL_TIMEOUT = parseInt(flag('detail-timeout') || '8000', 10);
const CDP_URL = process.env.CDP_URL || 'http://127.0.0.1:9222';

// ═══ Helpers ═══
function log(msg) { process.stderr.write(`[scraper] ${msg}\n`); }

// URL pattern matchers for Moodle activity types
const ASSIGN_PATTERNS = [/\/mod\/assign\//, /\/mod\/quiz\//];
const SKIP_PATTERNS   = [/\/mod\/forum\//, /\/mod\/resource\//, /\/mod\/page\//, /\/mod\/url\//,
                         /\/mod\/folder\//, /\/mod\/chat\//, /\/mod\/choice\//, /\/mod\/feedback\//];

function isAssignment(url)  { return ASSIGN_PATTERNS.some(p => p.test(url)); }
function isSkippable(url)   { return SKIP_PATTERNS.some(p => p.test(url)); }

function hasVisibleQuestion(text) {
  // Heuristic: a Moodle assignment description that contains actual question text
  // (not just "完成条件: 提交" boilerplate)
  if (!text || text.length < 20) return false;
  const boilerplate = ['完成条件', '作业状态', '提交评论', '剩余时间', '最后修改', '文件提交',
                       '评分状态', '作业过期', '尚未批改', '移除作业', '编辑作业', '添加作业'];
  const cleaned = boilerplate.reduce((t, b) => t.replace(new RegExp(b, 'g'), ''), text).trim();
  return cleaned.length > 15;
}

// ═══ Main ═══
(async () => {
  const startTime = Date.now();
  log('Connecting to Chrome CDP...');

  let browser;
  try {
    browser = await chromium.connectOverCDP(CDP_URL);
  } catch (e) {
    log(`FATAL: Cannot connect to CDP at ${CDP_URL} — ${e.message}`);
    process.exit(1);
  }

  const contexts = browser.contexts();
  if (!contexts.length) {
    log('FATAL: No browser contexts found');
    await browser.disconnect();
    process.exit(2);
  }
  const context = contexts[0];
  const pages = context.pages();

  // ── Step 1: Locate the Moodle course page ──
  /** @type {import('playwright-core').Page} */
  let coursePage = null;

  if (COURSE_URL) {
    // Reuse existing tab if already open, otherwise create one
    coursePage = pages.find(p => p.url() === COURSE_URL || p.url().startsWith(COURSE_URL));
    if (!coursePage) {
      log(`Opening course URL: ${COURSE_URL}`);
      coursePage = await context.newPage();
      await coursePage.goto(COURSE_URL, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await coursePage.waitForSelector('.course-content, #region-main, .activity', { timeout: 8000 }).catch(() => {});
    } else {
      log(`Reusing existing tab: ${coursePage.url().slice(0, 80)}`);
    }
  } else {
    // Auto-discover: find the first tab whose URL looks like a Moodle course page
    coursePage = pages.find(p => {
      const u = p.url();
      return u.includes('course/view.php') || u.includes('/course/');
    });
    if (!coursePage) {
      log('FATAL: No Moodle course tab found. Open the course page in Chrome or pass --course-url.');
      await browser.disconnect();
      process.exit(2);
    }
    log(`Auto-discovered course tab: ${coursePage.url().slice(0, 80)}`);
  }

  const courseTitle = await coursePage.title();
  log(`Course: ${courseTitle.slice(0, 60)}`);

  // ── Step 2: One-pass discovery — extract all assignments with metadata ──
  log('Extracting assignment list from course page...');

  const extracted = await coursePage.evaluate(() => {
    const results = [];
    // Moodle 4.x uses .activity, older versions use li.activity or .section .activity
    const nodes = document.querySelectorAll('.activity, li.activity, [class*="activity"]');

    nodes.forEach(node => {
      const linkNode = node.querySelector('a');
      if (!linkNode) return;

      const url = linkNode.href;
      // Skip non-assignment URLs early
      if (!url.includes('/mod/')) return;

      // Extract labels from common Moodle markup
      const instanceName = node.querySelector('.instancename, .activityname, h3, h4');
      const title = instanceName ? instanceName.innerText.trim() : linkNode.innerText.trim();

      // Get the full text content for summary (truncated to 600 chars for inline use)
      const fullText = (node.innerText || '').trim();
      const summary = fullText.length > 800 ? fullText.slice(0, 800) : fullText;

      // Determine activity type
      const typeMatch = url.match(/\/mod\/(\w+)\//);
      const modType = typeMatch ? typeMatch[1] : 'unknown';

      results.push({
        title: title || '(untitled)',
        url: url,
        modType: modType,
        summary: summary,
        // Quick heuristic: does the summary already contain the question?
        hasInlineQuestion: summary.length > 60 &&
          !summary.startsWith('完成条件') &&
          !summary.startsWith('作业状态')
      });
    });

    return results;
  });

  log(`Found ${extracted.length} raw activity nodes`);

  // ── De-duplicate by URL (Moodle renders the same activity in multiple DOM wrappers) ──
  const seen = new Set();
  const unique = [];
  for (const item of extracted) {
    const key = item.url;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  log(`${unique.length} unique activities after de-duplication`);

  // ── Step 3: Classify — which ones need detail-page scraping? ──
  const needDetail = [];
  const skip = [];

  for (const item of unique) {
    // Skip non-assignment types
    if (isSkippable(item.url)) {
      // Don't add forum/pages/resources to skip list at all — they're noise
      continue;
    }

    // If it IS an assignment/quiz AND doesn't have the question inline, we need detail
    if (isAssignment(item.url)) {
      if (item.hasInlineQuestion) {
        // Question text is already visible on the course page — no need to open detail
        skip.push({ ...item, reason: 'inline_question_present' });
      } else {
        needDetail.push(item);
      }
    }
    // Unrecognized mod types are silently dropped
  }

  log(`${needDetail.length} assignments need detail-page fetch, ${skip.length} have inline questions (no fetch needed), ${unique.length - needDetail.length - skip.length} non-assignment activities skipped`);

  // ── Step 4: Concurrent detail-page fetch ──
  const detailLimit = Math.min(needDetail.length, MAX_DETAIL);
  const toFetch = needDetail.slice(0, detailLimit);
  if (needDetail.length > MAX_DETAIL) {
    log(`Capping detail fetch at ${MAX_DETAIL} (${needDetail.length - MAX_DETAIL} skipped)`);
  }

  const detailResults = await Promise.all(toFetch.map(async (item) => {
    const pageStart = Date.now();
    let detailPage;
    try {
      detailPage = await context.newPage();
      await detailPage.goto(item.url, {
        waitUntil: 'domcontentloaded',
        timeout: DETAIL_TIMEOUT
      });

      // Wait for Moodle content area to render (signal-driven, not fixed timeout)
      await detailPage.waitForSelector('#intro, .generalbox, .no-overflow, [role="main"] .box', {
        timeout: 4000
      }).catch(() => {
        // If the main content selectors aren't found, page might be loading slowly
        // Give one more chance with a broader selector
        return detailPage.waitForSelector('#region-main', { timeout: 2000 }).catch(() => {});
      });

      const detailData = await detailPage.evaluate(() => {
        // Try multiple Moodle content selectors in priority order
        const contentNode =
          document.querySelector('#intro') ||
          document.querySelector('.generalbox') ||
          document.querySelector('.no-overflow') ||
          document.querySelector('[role="main"] .box') ||
          document.querySelector('#region-main');

        const description = contentNode ? contentNode.innerText.trim() : '';

        // Extract downloadable files
        const fileLinks = document.querySelectorAll('a[href*="pluginfile.php"], a[href$=".pdf"], a[href$=".pptx"], a[href$=".docx"]');
        const files = Array.from(fileLinks).map(a => ({
          name: (a.innerText || a.getAttribute('aria-label') || a.href.split('/').pop()).trim(),
          url: a.href
        }));

        return { description, files };
      });

      item.detail = detailData;
      item.hasQuestionText = hasVisibleQuestion(detailData.description);
      item.fetchMs = Date.now() - pageStart;

      return item;
    } catch (e) {
      item.detail = { error: e.message };
      item.hasQuestionText = false;
      item.fetchMs = Date.now() - pageStart;
      return item;
    } finally {
      if (detailPage) {
        try { await detailPage.close(); } catch (_) { /* ignore */ }
      }
    }
  }));

  // ── Step 5: Merge results — inline + detail-fetched ──
  const finalAssignments = [];

  // Items with inline questions from the course page
  for (const item of skip.filter(s => s.reason === 'inline_question_present')) {
    finalAssignments.push({
      title: item.title,
      url: item.url,
      modType: item.modType,
      source: 'course_page',
      questionText: item.summary,
      files: []
    });
  }

  // Items we fetched from detail pages
  for (const item of detailResults) {
    const detail = item.detail || {};
    finalAssignments.push({
      title: item.title,
      url: item.url,
      modType: item.modType,
      source: detail.error ? 'detail_fetch_failed' : 'detail_page',
      questionText: detail.description || item.summary || '',
      files: detail.files || [],
      fetchError: detail.error || null,
      hasQuestionText: item.hasQuestionText || false
    });
  }

  const elapsed = Date.now() - startTime;

  // If stdout is a pipe (consumed by another program), output pure JSON.
  // If stdout is a TTY (human reading), wrap with metadata.
  const result = {
    course_title: courseTitle,
    course_url: coursePage.url(),
    scraped_at: new Date().toISOString(),
    elapsed_ms: elapsed,
    total_activities: extracted.length,
    assignments_with_questions: finalAssignments.filter(a => a.hasQuestionText || a.questionText.length > 20).length,
    detail_fetched: detailResults.length,
    detail_failed: detailResults.filter(r => r.detail?.error).length,
    assignments: finalAssignments
  };

  if (process.stdout.isTTY) {
    log(`\n═══ Scrape Complete ═══`);
    log(`Total: ${elapsed}ms | ${result.assignments_with_questions} with questions | ${result.total_activities} total activities`);
    log('');
    console.log(JSON.stringify(result, null, 2));
  } else {
    console.log(JSON.stringify(result));
  }

  // playwright-core CDP: use close() which sends Browser.close CDP command
  // but doesn't kill the actual Chrome process (unlike launch+close)
  try { await browser.close(); } catch (_) { /* CDP close may throw on some versions */ }
  log('Done.');
})().catch(e => {
  log(`FATAL: ${e.message}`);
  process.exit(4);
});
