'use strict';

/**
 * Translations of the log messages. One JSON file per language in lib/i18n/<language>.json,
 * placeholders are written as {name}. English is used as fallback for missing languages or keys.
 */

const fs = require('node:fs');
const path = require('node:path');

const I18N_DIR = path.join(__dirname, 'i18n');
const FALLBACK_LANGUAGE = 'en';

/**
 * @param {string} language - Language code, e.g. "de"
 * @returns {Record<string, string> | null} messages of this language, null if there is no file
 */
function loadLanguage(language) {
	const file = path.join(I18N_DIR, `${language}.json`);
	if (!/^[a-z]{2}(-[a-z]{2})?$/.test(language) || !fs.existsSync(file)) {
		return null;
	}
	return JSON.parse(fs.readFileSync(file, 'utf8'));
}

/**
 * Holds the messages of the selected language and formats them.
 */
class I18n {
	/**
	 * Starts with English, call setLanguage() to switch.
	 */
	constructor() {
		/** @type {Record<string, string>} */
		this.fallback = loadLanguage(FALLBACK_LANGUAGE) || {};
		/** @type {Record<string, string>} */
		this.messages = this.fallback;
		this.language = FALLBACK_LANGUAGE;
	}

	/**
	 * Selects the language. Unknown languages fall back to English.
	 *
	 * @param {string | null | undefined} language - Language code, e.g. the system language of ioBroker
	 */
	setLanguage(language) {
		const lang = String(language || '').toLowerCase();
		const messages = lang ? loadLanguage(lang) : null;
		this.messages = messages || this.fallback;
		this.language = messages ? lang : FALLBACK_LANGUAGE;
	}

	/**
	 * Returns the translated message with all {placeholders} replaced.
	 *
	 * @param {string} key - Message key
	 * @param {Record<string, unknown>} [params] - Values for the placeholders
	 * @returns {string} translated message
	 */
	t(key, params = {}) {
		const template = this.messages[key] ?? this.fallback[key] ?? key;
		return template.replace(/\{(\w+)\}/g, (match, name) =>
			Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match,
		);
	}
}

module.exports = { I18n };
