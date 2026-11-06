import { ProxyParser } from '../parsers/index.js';
import { createStableProviderName, deepCopy, tryDecodeSubscriptionLines, decodeBase64, parseServerInfo, parseUrlParams, parseBool } from '../utils.js';
import { createTranslator } from '../i18n/index.js';
import { generateRules, getOutbounds, PREDEFINED_RULE_SETS } from '../config/index.js';

// 内部高兼容性 HY2 直通解析
function parseHysteria2Direct(urlStr) {
    try {
        const { addressPart, params, name } = parseUrlParams(urlStr);
        let password = '';
        let actualHost = addressPart;
        
        if (addressPart.includes('@')) {
            const atIndex = addressPart.lastIndexOf('@');
            password = addressPart.slice(0, atIndex);
            actualHost = addressPart.slice(atIndex + 1);
        }
        
        const { host, port } = parseServerInfo(actualHost);
        if (!host || !port) return null;

        return {
            tag: name || `${host}:${port}`,
            type: 'hysteria2',
            server: host,
            server_port: port,
            password: password || params.password || params.auth || '',
            up: params.up,
            down: params.down,
            obfs: params.obfs ? { type: params.obfs, password: params['obfs-password'] || params.obfs_password } : undefined,
            tls: {
                enabled: true,
                server_name: params.sni || host,
                insecure: parseBool(params.insecure || params.allowInsecure || params.allow_insecure, false),
            },
            alpn: params.alpn ? params.alpn.split(',') : undefined,
        };
    } catch (e) {
        return null;
    }
}

export class BaseConfigBuilder {
    constructor(inputString, baseConfig, lang, userAgent, groupByCountry = false, includeAutoSelect = true) {
        this.inputString = inputString;
        this.config = deepCopy(baseConfig);
        this.customRules = [];
        this.selectedRules = [];
        this.t = createTranslator(lang);
        this.userAgent = userAgent;
        this.appliedOverrideKeys = new Set();
        this.groupByCountry = groupByCountry;
        this.includeAutoSelect = includeAutoSelect;
        this.providerUrls = [];
        this.providerNodeNames = [];
        this.autoProviderDescriptors = undefined;
        this.subscriptionUserinfo = undefined;
    }

    async build() {
        const customItems = await this.parseCustomItems();
        this.addCustomItems(customItems);
        this.addSelectors();
        return this.formatConfig();
    }

    async parseCustomItems() {
        const input = this.inputString || '';
        const parsedItems = [];

        const urls = input.split('\n').filter(url => url.trim() !== '');
        for (const url of urls) {
            let processedUrls = tryDecodeSubscriptionLines(url);
            if (!Array.isArray(processedUrls)) {
                processedUrls = [processedUrls];
            }

            for (const processedUrl of processedUrls) {
                const trimmedUrl = typeof processedUrl === 'string' ? processedUrl.trim() : '';
                if (!trimmedUrl) continue;

                let result = null;

                // 1. 处理 HTTP(S) 远程订阅链接
                if (trimmedUrl.startsWith('http://') || trimmedUrl.startsWith('https://')) {
                    try {
                        const { fetchSubscriptionWithFormat } = await import('../parsers/subscription/httpSubscriptionFetcher.js');
                        const fetchResult = await fetchSubscriptionWithFormat(trimmedUrl, this.userAgent);
                        if (fetchResult) {
                            const { content, format, url: originalUrl, subscriptionUserinfo } = fetchResult;
                            if (subscriptionUserinfo && !this.subscriptionUserinfo) {
                                this.subscriptionUserinfo = subscriptionUserinfo;
                            }
                            if (this.isCompatibleProviderFormat(format)) {
                                this.providerUrls.push(originalUrl);
                                await this.collectProviderNodeNames(content);
                                continue;
                            }

                            // 🟢 核心增强：对远程内容进行 Base64 深度解码
                            let rawContent = content;
                            try {
                                const decoded = decodeBase64(content.replace(/\s+/g, ''));
                                if (decoded && decoded.length > 0) {
                                    rawContent = decoded;
                                }
                            } catch (_) {}

                            // 🟢 暴力匹配：使用正则在整篇远程内容中直接提取所有 hy2:// 或 hysteria2:// 链接
                            const hy2Regex = /(?:hy2|hysteria2):\/\/[^\s<>"']+/g;
                            const matchedHy2Links = rawContent.match(hy2Regex) || [];
                            for (const hy2Link of matchedHy2Links) {
                                const parsedProxy = parseHysteria2Direct(hy2Link);
                                if (parsedProxy) {
                                    parsedItems.push(parsedProxy);
                                }
                            }

                            // 同时通过常规分行解析其他协议链接
                            const lines = rawContent.split('\n').map(l => l.trim()).filter(Boolean);
                            for (const line of lines) {
                                if (!line.includes('://') || line.startsWith('hy2://') || line.startsWith('hysteria2://')) continue;
                                const parsedProxy = await ProxyParser.parse(line, this.userAgent);
                                if (parsedProxy) {
                                    if (Array.isArray(parsedProxy)) parsedItems.push(...parsedProxy);
                                    else parsedItems.push(parsedProxy);
                                }
                            }

                            // 兼容 YAML/JSON 格式订阅
                            const { parseSubscriptionContent } = await import('../parsers/subscription/subscriptionContentParser.js');
                            const subContentResult = parseSubscriptionContent(rawContent);
                            if (subContentResult && Array.isArray(subContentResult.proxies)) {
                                subContentResult.proxies.forEach(p => {
                                    if (p && (p.tag || p.name)) {
                                        if (p.type === 'hysteria2' || p.type === 'hy2') {
                                            parsedItems.push({
                                                tag: p.name || p.tag,
                                                type: 'hysteria2',
                                                server: p.server,
                                                server_port: p.port || p.server_port,
                                                password: p.password || p.auth,
                                                up: p.up,
                                                down: p.down,
                                                obfs: p.obfs ? { type: p.obfs, password: p['obfs-password'] } : undefined,
                                                tls: {
                                                    enabled: true,
                                                    server_name: p.sni || p.server,
                                                    insecure: !!p['skip-cert-verify']
                                                },
                                                alpn: p.alpn
                                            });
                                        } else {
                                            parsedItems.push(p);
                                        }
                                    }
                                });
                            }
                        }
                    } catch (e) {
                        console.error('Error fetching remote subscription:', e);
                    }
                    continue;
                } 
                // 2. 处理单条链接
                else if (trimmedUrl.startsWith('hy2://') || trimmedUrl.startsWith('hysteria2://') || trimmedUrl.startsWith('hysteria://')) {
                    result = parseHysteria2Direct(trimmedUrl);
                } else {
                    result = await ProxyParser.parse(trimmedUrl, this.userAgent);
                }

                if (result) {
                    if (Array.isArray(result)) {
                        parsedItems.push(...result);
                    } else {
                        parsedItems.push(result);
                    }
                }
            }
        }
        return parsedItems;
    }

    isCompatibleProviderFormat(format) { return false; }

    async collectProviderNodeNames(content) {
        try {
            const { parseSubscriptionContent } = await import('../parsers/subscription/subscriptionContentParser.js');
            const result = parseSubscriptionContent(content);
            const proxies = Array.isArray(result?.proxies) ? result.proxies : [];
            proxies.forEach(proxy => {
                const name = proxy?.tag ?? proxy?.name;
                if (typeof name === 'string' && name.trim()) {
                    this.providerNodeNames.push(name.trim());
                }
            });
        } catch (_) { }
    }

    getAutoProviderDescriptors(reservedNames = []) {
        if (this.autoProviderDescriptors) return this.autoProviderDescriptors;
        const usedNames = new Set(reservedNames);
        const providerNamesByUrl = new Map();
        const descriptors = [];

        for (const url of this.providerUrls) {
            const normalizedUrl = url.trim();
            if (providerNamesByUrl.has(normalizedUrl)) continue;
            const baseName = createStableProviderName(normalizedUrl);
            let name = baseName;
            let suffix = 2;
            while (usedNames.has(name)) {
                name = `${baseName}_${suffix}`;
                suffix += 1;
            }
            usedNames.add(name);
            providerNamesByUrl.set(normalizedUrl, name);
            descriptors.push({ name, url: normalizedUrl });
        }
        this.autoProviderDescriptors = descriptors;
        return descriptors;
    }

    applyConfigOverrides(overrides) {
        if (!overrides || typeof overrides !== 'object') return;
        const blacklistedKeys = new Set(['proxies', 'rules', 'rule-providers', 'proxy-groups']);
        Object.entries(overrides).forEach(([key, value]) => {
            if (blacklistedKeys.has(key)) return;
            if (value === undefined) {
                delete this.config[key];
                this.appliedOverrideKeys.add(key);
            } else {
                this.config[key] = deepCopy(value);
                this.appliedOverrideKeys.add(key);
            }
        });
    }

    hasConfigOverride(key) { return this.appliedOverrideKeys?.has(key); }
    getSubscriptionUserinfo() { return this.subscriptionUserinfo; }

    getOutboundsList() {
        if (typeof this.selectedRules === 'string' && PREDEFINED_RULE_SETS[this.selectedRules]) {
            return getOutbounds(PREDEFINED_RULE_SETS[this.selectedRules]);
        }
        return getOutbounds(this.selectedRules && Object.keys(this.selectedRules).length > 0 ? this.selectedRules : PREDEFINED_RULE_SETS.minimal);
    }

    getProxyList() { return this.getProxies().map(proxy => this.getProxyName(proxy)); }
    getProxies() { throw new Error('getProxies must be implemented'); }
    getProxyName(proxy) { throw new Error('getProxyName must be implemented'); }
    convertProxy(proxy) { throw new Error('convertProxy must be implemented'); }
    addProxyToConfig(proxy) { throw new Error('addProxyToConfig must be implemented'); }
    addAutoSelectGroup(proxyList) { throw new Error('addAutoSelectGroup must be implemented'); }
    addNodeSelectGroup(proxyList) { throw new Error('addNodeSelectGroup must be implemented'); }
    addOutboundGroups(outbounds, proxyList) { throw new Error('addOutboundGroups must be implemented'); }
    addCustomRuleGroups(proxyList) { throw new Error('addCustomRuleGroups must be implemented'); }
    addFallBackGroup(proxyList) { throw new Error('addFallBackGroup must be implemented'); }
    addCountryGroups() { throw new Error('addCountryGroups must be implemented'); }

    addCustomItems(customItems) {
        const validItems = customItems.filter(item => item != null);
        validItems.forEach(item => {
            if (item?.tag || item?.name) {
                const convertedProxy = this.convertProxy(item);
                if (convertedProxy) {
                    this.addProxyToConfig(convertedProxy);
                }
            }
        });
    }

    addSelectors() {
        const outbounds = this.getOutboundsList();
        const proxyList = this.getProxyList();
        this.addAutoSelectGroup(proxyList);
        this.addNodeSelectGroup(proxyList);
        if (this.groupByCountry) this.addCountryGroups();
        this.addOutboundGroups(outbounds, proxyList);
        this.addCustomRuleGroups(proxyList);
        this.addFallBackGroup(proxyList);
    }

    mergeUserProxyGroups(userGroups) {}
    generateRules() { return generateRules(this.selectedRules, this.customRules); }
    formatConfig() { throw new Error('formatConfig must be implemented'); }
}
