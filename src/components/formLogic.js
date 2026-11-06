export const formLogicFn = (t) => {
    window.formData = function () {
        return {
            input: '',
            showAdvanced: false,
            selectedRules: [],
            selectedPredefinedRule: 'balanced',
            groupByCountry: false,
            includeAutoSelect: true,
            enableClashUI: false,
            externalController: '',
            externalUiDownloadUrl: '',
            loading: false,
            generatedLinks: null,
            shortenedLinks: null,
            shortening: false,
            customShortCode: '',
            processingText: '',
            convertText: '',
            shortenLinksText: '',
            shorteningText: '',
            showFullLinksText: '',

            init() {
                if (window.APP_TRANSLATIONS) {
                    this.processingText = window.APP_TRANSLATIONS.processing;
                    this.convertText = window.APP_TRANSLATIONS.convert;
                    this.shortenLinksText = window.APP_TRANSLATIONS.shortenLinks;
                    this.shorteningText = window.APP_TRANSLATIONS.shortening;
                    this.showFullLinksText = window.APP_TRANSLATIONS.showFullLinks;
                }
                this.input = localStorage.getItem('inputTextarea') || '';
                this.applyPredefinedRule();

                this.$watch('input', val => {
                    localStorage.setItem('inputTextarea', val);
                });
            },

            applyPredefinedRule() {
                if (this.selectedPredefinedRule === 'custom') return;
                const rules = window.PREDEFINED_RULE_SETS;
                if (rules && rules[this.selectedPredefinedRule]) {
                    this.selectedRules = rules[this.selectedPredefinedRule];
                }
            },

            async submitForm() {
                this.loading = true;
                this.shortenedLinks = null;
                try {
                    const origin = window.location.origin;
                    const params = new URLSearchParams();
                    params.append('config', this.input);
                    params.append('selectedRules', JSON.stringify(this.selectedRules));

                    if (this.groupByCountry) params.append('group_by_country', 'true');
                    if (!this.includeAutoSelect) params.append('include_auto_select', 'false');

                    const queryString = params.toString();

                    this.generatedLinks = {
                        xray: origin + '/xray?' + queryString,
                        singbox: origin + '/singbox?' + queryString,
                        clash: origin + '/clash?' + queryString,
                        mihomo: origin + '/mihomo?' + queryString,
                        surge: origin + '/surge?' + queryString
                    };

                    setTimeout(() => {
                        const resultsDiv = document.querySelector('.mt-12');
                        if (resultsDiv) {
                            resultsDiv.scrollIntoView({ behavior: 'smooth' });
                        }
                    }, 100);
                } catch (error) {
                    console.error('Error generating links:', error);
                    alert(window.APP_TRANSLATIONS.errorGeneratingLinks);
                } finally {
                    this.loading = false;
                }
            },

            clearAll() {
                this.input = '';
                this.generatedLinks = null;
                this.shortenedLinks = null;
            }
        }
    }
};
