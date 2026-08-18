'use strict';

const COMMON_QUOTA_PATTERNS = [
    /今日.*(?:积分|额度|次数).*(?:已用完|不足|耗尽)/i,
    /(?:积分|额度|次数).*(?:不足|用完|耗尽|明天|次日)/i,
    /免费.*(?:次数|额度).*(?:用完|耗尽)/i,
    /升级.*会员|开通.*会员|购买.*积分/i,
    /quota|limit reached/i,
];

const COMMON_AUTH_PATTERNS = [
    /请登录|登录后继续|扫码登录|手机号登录/i,
    /sign.?in|log.?in/i,
];

const COMMON_PROCESSING_PATTERNS = [
    /生成中|正在生成|创作中|排队中|处理中|预计.*分钟/i,
    /generating|processing|queued/i,
];

const COMMON_FAILURE_PATTERNS = [
    /生成失败|创作失败|任务失败|请重试/i,
    /generation failed|try again/i,
];

const COMMON_SAFETY_PATTERNS = [
    /疑似包含.*(?:侵权|违规)|违规内容|侵权内容/i,
    /无法返回该内容|换个主题再试/i,
    /内容.*审核.*未通过|安全审核/i,
    /policy|safety violation|copyright/i,
];

const configs = {
    chatgpt: {
        key: 'chatgpt',
        name: 'ChatGPT Web',
        runner: 'oneweb',
        hosts: ['chatgpt.com'],
        supports: { image: true, video: false },
        urlForTask: () => 'https://chatgpt.com/',
    },
    doubao: {
        key: 'doubao',
        name: '豆包',
        hosts: ['doubao.com'],
        supports: { image: true, video: true },
        urlForTask: () => 'https://www.doubao.com/chat/',
        modeLabels: {
            image: ['图片生成', 'AI生图', '生成图片'],
            video: ['视频生成', 'AI视频', '生成视频'],
        },
        modeActiveSelectors: {
            video: [
                'button[data-input-engine-actionbar-control-key="video-model"]',
            ],
        },
        editorSelectors: [
            'div.tiptap.ProseMirror',
            '.tiptap.ProseMirror',
            'textarea[placeholder*="输入"]',
            '[contenteditable="true"][role="textbox"]',
            '[contenteditable="true"]',
            'textarea',
        ],
        uploadSelectors: [
            'input[type="file"][accept*="image"]',
            'input[type="file"]',
        ],
        generateSelectors: [
            '#flow-end-msg-send',
            'button:has-text("生成")',
            'button:has-text("发送")',
            'button[aria-label*="发送"]',
        ],
        resultSelectors: ['video', 'img'],
        downloadSelectors: [
            'button:has-text("下载")',
            'a:has-text("下载")',
            '[aria-label*="下载"]',
        ],
        quotaPatterns: COMMON_QUOTA_PATTERNS,
        authPatterns: COMMON_AUTH_PATTERNS,
        processingPatterns: COMMON_PROCESSING_PATTERNS,
        failurePatterns: COMMON_FAILURE_PATTERNS,
        safetyPatterns: COMMON_SAFETY_PATTERNS,
        defaultDurationSeconds: 10,
        defaultResolution: null,
        freePreferredModels: ['Seedance 2.0 Mini'],
        probeRequirements: {
            uploadButton: false,
            skillButton: false,
            generateButton: false,
            resolution: false,
            customDurationButton: false,
            durationText: false,
            durationRange: false,
        },
        probeControls: {
            uploadButtonSelectors: [],
            uploadInputSelectors: [
                'input[type="file"][accept*=".jpg"]',
                'input[type="file"][accept*="image"]',
                'input[type="file"]',
            ],
            skillButtonSelectors: [],
            modelButtonSelectors: [
                'button[data-input-engine-actionbar-control-key="video-model"]',
            ],
            settingsButtonSelectors: [
                'button[data-input-engine-actionbar-render-entry-key="video-generation-params-panel"]',
            ],
            modelSelectors: [
                '[role="menuitem"]:has-text("Seedance 2.5")',
                '[role="menuitem"]:has-text("Seedance 2.0 Fast")',
                '[role="menuitem"]:has-text("Seedance 2.0 Mini")',
            ],
            aspectRatioSelectors: [
                '[role="menu"] button:has-text("自动")',
                '[role="menu"] button:has-text("3:4")',
                '[role="menu"] button:has-text("4:3")',
                '[role="menu"] button:has-text("9:16")',
                '[role="menu"] button:has-text("16:9")',
                '[role="menu"] button:has-text("1:1")',
                '[role="menu"] button:has-text("21:9")',
            ],
            resolutionSelectors: [],
            customDurationButtonSelectors: [],
            durationTextSelector: null,
            durationRangeSelector: null,
            durationRoleSelector: '[role="menu"] [role="slider"]',
            durationValueOffset: 4,
        },
        durationSelectorCandidates: [
            '[role="menu"] [role="slider"]',
        ],
    },
    jimeng: {
        key: 'jimeng',
        name: '即梦',
        hosts: ['jimeng.jianying.com'],
        supports: { image: true, video: true },
        urlForTask: (task) => task.mediaType === 'video'
            ? 'https://jimeng.jianying.com/ai-tool/video-generation'
            : 'https://jimeng.jianying.com/ai-tool/image-generation',
        modeLabels: {
            image: ['图片生成', '文生图', '智能画布'],
            video: ['视频生成', '文生视频', '图生视频'],
        },
        editorSelectors: [
            'textarea[placeholder*="描述"]',
            'textarea[placeholder*="输入"]',
            '[contenteditable="true"][role="textbox"]',
            '[contenteditable="true"]',
            'textarea',
        ],
        uploadSelectors: [
            'input[type="file"][accept*="image"]',
            'input[type="file"]',
        ],
        generateSelectors: [
            'button:has-text("生成")',
            'button:has-text("立即生成")',
            '[class*="generate"] button',
        ],
        resultSelectors: ['video', 'img'],
        downloadSelectors: [
            'button:has-text("下载")',
            'a:has-text("下载")',
            '[aria-label*="下载"]',
        ],
        quotaPatterns: COMMON_QUOTA_PATTERNS,
        authPatterns: COMMON_AUTH_PATTERNS,
        processingPatterns: COMMON_PROCESSING_PATTERNS,
        failurePatterns: COMMON_FAILURE_PATTERNS,
        safetyPatterns: COMMON_SAFETY_PATTERNS,
        defaultDurationSeconds: 10,
        durationSelectorCandidates: [],
    },
    xiaoyunque: {
        key: 'xiaoyunque',
        name: '小云雀',
        hosts: ['xyq.jianying.com'],
        supports: { image: true, video: true },
        urlForTask: () => 'https://xyq.jianying.com/home?tab_name=home',
        modeLabels: {
            image: ['图片生成', 'AI图片', '文生图'],
            video: ['视频生成', 'AI视频', '文生视频', '图生视频'],
        },
        editorSelectors: [
            '.tiptap.ProseMirror',
            'div.tiptap.ProseMirror',
            'textarea[placeholder*="描述"]',
            'textarea[placeholder*="输入"]',
            '[contenteditable="true"][role="textbox"]',
            '[contenteditable="true"]',
            'textarea',
        ],
        uploadSelectors: [
            'input[type="file"][multiple][accept*="image/jpeg"][accept*="video/mp4"]',
            'input[type="file"][accept*="image"]',
            'input[type="file"]',
        ],
        generateSelectors: [
            'button[aria-label="开始生成"]',
            'button[aria-label="生成"]',
            'button:has-text("生成")',
            'button:has-text("立即生成")',
            '[class*="generate"] button',
        ],
        resultSelectors: ['video', 'img'],
        downloadSelectors: [
            'button:has-text("下载")',
            'a:has-text("下载")',
            '[aria-label*="下载"]',
        ],
        quotaPatterns: COMMON_QUOTA_PATTERNS,
        authPatterns: COMMON_AUTH_PATTERNS,
        processingPatterns: COMMON_PROCESSING_PATTERNS,
        failurePatterns: COMMON_FAILURE_PATTERNS,
        safetyPatterns: COMMON_SAFETY_PATTERNS,
        defaultDurationSeconds: null,
        defaultResolution: '720P',
        freePreferredModels: ['Seedance 2.0 Mini 体验版'],
        autoSelectSkill: false,
        fashionSkill: {
            label: '服装带货视频生成',
            id: 'fashion-ecommerce-creator',
            note: 'Selecting this skill may switch to a VIP model, so it is never auto-selected.',
        },
        probeControls: {
            uploadButtonSelectors: ['button[aria-label="上传参考素材"]'],
            uploadInputSelectors: [
                'input[type="file"][multiple][accept*="image/jpeg"][accept*="video/mp4"]',
            ],
            skillButtonSelectors: ['button:has-text("技能")'],
            settingsButtonSelectors: [
                'button[aria-label^="模型选择和偏好设置"]',
            ],
            modelSelectors: [
                '[role="dialog"] button:has-text("智能匹配")',
                '[role="dialog"] button:has-text("Seedance 2.5")',
                '[role="dialog"] button:has-text("Seedance 2.0 Fast VIP")',
                '[role="dialog"] button:has-text("Seedance 2.0 VIP")',
                '[role="dialog"] button:has-text("Seedance 2.0 Mini 体验版")',
                '[role="dialog"] button:has-text("Seedance 2.0 Mini")',
                '[role="dialog"] button:has-text("MiniMax H3")',
            ],
            aspectRatioSelectors: [
                '[role="dialog"] [role="radio"]:has-text("智能")',
                '[role="dialog"] [role="radio"]:has-text("16:9")',
                '[role="dialog"] [role="radio"]:has-text("21:9")',
                '[role="dialog"] [role="radio"]:has-text("9:16")',
                '[role="dialog"] [role="radio"]:has-text("4:3")',
                '[role="dialog"] [role="radio"]:has-text("3:4")',
                '[role="dialog"] [role="radio"]:has-text("1:1")',
            ],
            resolutionSelectors: [
                '[role="dialog"] button:has-text("480P")',
                '[role="dialog"] button:has-text("720P")',
                '[role="dialog"] button:has-text("1080P")',
                '[role="dialog"] button:has-text("4K")',
            ],
            customDurationButtonSelectors: [
                '[role="dialog"] button:has-text("自定义时长")',
            ],
            durationTextSelector: 'input[aria-label="视频时长秒数"]',
            durationRangeSelector: 'input[aria-label="视频秒数"]',
        },
        durationSelectorCandidates: [
            'input[aria-label="视频时长秒数"]',
            'input[aria-label="视频秒数"]',
        ],
    },
};

function getProviderConfig(key) {
    return configs[String(key || '').toLowerCase()] || null;
}

module.exports = {
    getProviderConfig,
    configs,
    COMMON_QUOTA_PATTERNS,
    COMMON_AUTH_PATTERNS,
    COMMON_PROCESSING_PATTERNS,
    COMMON_FAILURE_PATTERNS,
    COMMON_SAFETY_PATTERNS,
};
