module.exports = Ferdium =>
  class Wire extends Ferdium {
    overrideUserAgent() {
      return window.navigator.userAgent
        .replaceAll(/(MacTranslate|Ferdium|Electron)\/\S+\s*(\([^)]+\))?/g, '')
        .replaceAll(/\s{2,}/g, ' ')
        .trim();
    }

    modifyRequestHeaders() {
      const userAgent = this.overrideUserAgent();
      return [
        {
          headers: {
            'user-agent': userAgent,
          },
          requestFilters: {
            urls: ['*://*.wire.com/*'],
          },
        },
      ];
    }
  };
