import yaml from 'js-yaml';
import { ClashConfigBuilder } from './ClashConfigBuilder.js';
import { generateClashRuleSets } from '../config/index.js';
import { emitClashRules, sanitizeClashProxyGroups } from './helpers/clashConfigUtils.js';

/**
 * Mihomo (Clash Meta) 配置生成器
 * 继承 ClashConfigBuilder，完全复用 VLESS / Hysteria2 / TUIC / AnyTLS 等节点转换与分组逻辑
 * 扩展提供：Fake-IP DNS、🤖 AI 服务与 🐱 GitHub 独立策略组及 GEOSITE 规则集
 */
export class MihomoConfigBuilder extends ClashConfigBuilder {
    constructor(
        inputString,
        selectedRules,
        customRules,
        baseConfig,
        lang,
        userAgent = 'mihomo',
        groupByCountry = false,
        enableClashUI = false,
        externalController,
        externalUiDownloadUrl,
        includeAutoSelect = true
    ) {
        super(
            inputString,
            selectedRules,
            customRules,
            baseConfig,
            lang,
            userAgent,
            groupByCountry,
            enableClashUI,
            externalController,
            externalUiDownloadUrl,
            includeAutoSelect
        );
    }

    /**
     * 重写 formatConfig，生成专属于 Mihomo 的配置文件
     */
    formatConfig() {
        // 1. 设置适用于 Mihomo 的 Fake-IP DNS 节点
        this.config.dns = {
            enable: true,
            ipv6: false,
            'enhanced-mode': 'fake-ip',
            'fake-ip-range': '198.18.0.1/16',
            'default-nameserver': ['119.29.29.29', '223.5.5.5'],
            nameserver: [
                'https://doh.pub/dns-query',
                'https://dns.alidns.com/dns-query'
            ],
            fallback: [
                'https://1.1.1.1/dns-query',
                'https://dns.google/dns-query'
            ],
            'fallback-filter': {
                geoip: true,
                'geoip-code': 'CN',
                ipcidr: ['240.0.0.0/4']
            },
            ...(this.config.dns || {})
        };

        // 2. 获取节点成员列表及代理提供者（Providers）
        this.config['proxy-groups'] = this.config['proxy-groups'] || [];
        const proxyList = typeof this.getProxyList === 'function' ? this.getProxyList() : [];
        const selectMembers = this.buildSelectGroupMembers(proxyList);
        const providerNames = this.getAllProviderNames();

        // 3. 动态补全 🤖 AI 服务 策略组
        if (!this.hasProxyGroup('🤖 AI 服务')) {
            const aiGroup = {
                type: 'select',
                name: '🤖 AI 服务',
                proxies: [...selectMembers]
            };
            if (providerNames.length > 0) aiGroup.use = providerNames;
            // 插入到首个全局节点选择组之后
            this.config['proxy-groups'].splice(1, 0, aiGroup);
        }

        // 4. 动态补全 🐱 GitHub 策略组
        if (!this.hasProxyGroup('🐱 GitHub')) {
            const githubGroup = {
                type: 'select',
                name: '🐱 GitHub',
                proxies: [...selectMembers]
            };
            if (providerNames.length > 0) githubGroup.use = providerNames;
            this.config['proxy-groups'].splice(2, 0, githubGroup);
        }

        // 5. 生成规则及 Rule Providers（默认启用针对 Mihomo 的 MRS 二进制格式）
        const rules = this.generateRules();
        const { site_rule_providers, ip_rule_providers } = generateClashRuleSets(
            this.selectedRules,
            this.customRules,
            true
        );
        
        this.config['rule-providers'] = {
            ...site_rule_providers,
            ...ip_rule_providers
        };

        const ruleResults = emitClashRules(rules, this.t);

        // 6. 追加 Mihomo 特有的 GEOSITE 规则 (AI 与 GitHub 独立分流)
        const mihomoSpecificRules = [
            'GEOSITE,openai,🤖 AI 服务',
            'GEOSITE,claude,🤖 AI 服务',
            'GEOSITE,category-ai-chat-us,🤖 AI 服务',
            'GEOSITE,github,🐱 GitHub'
        ];

        // 7. 合并规则列表
        this.config.rules = [
            ...mihomoSpecificRules,
            ...ruleResults,
            `MATCH,${this.t('outboundNames.Fall Back')}`
        ];

        // 8. 挂载 proxy-providers（如果存在订阅源）
        if (this.providerUrls && this.providerUrls.length > 0) {
            this.config['proxy-providers'] = {
                ...this.config['proxy-providers'],
                ...this.generateProxyProviders()
            };
        }

        // 9. 执行策略组校验与清理
        sanitizeClashProxyGroups(this.config);
        this.validateProxyGroups();

        // 10. 处理 Dashboard / Web UI 选项
        if (this.enableClashUI || this.externalController || this.externalUiDownloadUrl) {
            const defaultController = '0.0.0.0:9090';
            const defaultUiPath = './ui';
            const defaultUiName = 'zashboard';
            const defaultUiUrl = 'https://gh-proxy.com/https://github.com/Zephyruso/zashboard/archive/refs/heads/gh-pages.zip';
            const defaultSecret = '';

            const controller = this.externalController || this.config['external-controller'] || defaultController;
            const uiPath = this.config['external-ui'] || defaultUiPath;
            const uiName = this.config['external-ui-name'] || defaultUiName;
            const uiUrl = this.externalUiDownloadUrl || this.config['external-ui-url'] || defaultUiUrl;
            const secret = this.config['secret'] ?? defaultSecret;

            this.config['external-controller'] = controller;
            this.config['external-ui'] = uiPath;
            this.config['external-ui-name'] = uiName;
            this.config['external-ui-url'] = uiUrl;
            this.config['secret'] = secret;
        }

        // 11. 导出 YAML
        return yaml.dump(this.config);
    }
}
