const searchBase = 'https://www.google.com/search?q=';
export function normalizeNavigationInput(input) {
    const value = input.trim();
    if (!value) {
        return 'about:blank';
    }
    if (/^[a-z][a-z0-9+.-]*:/i.test(value)) {
        return value;
    }
    if (isLikelyHost(value)) {
        return `https://${value}`;
    }
    return `${searchBase}${encodeURIComponent(value)}`;
}
function isLikelyHost(value) {
    if (/\s/.test(value)) {
        return false;
    }
    if (/^localhost(?::\d+)?(?:\/.*)?$/i.test(value)) {
        return true;
    }
    if (/^\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/.*)?$/.test(value)) {
        return true;
    }
    return /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/.*)?$/i.test(value);
}
