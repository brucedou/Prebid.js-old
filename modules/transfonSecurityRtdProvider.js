/**
 * This module adds the Transfon Security traffic quality verdict to the auction.
 * @module modules/transfonSecurityRtdProvider
 * @requires module:modules/realTimeData
 */

import { submodule } from '../src/hook.js';
import { ajaxBuilder } from '../src/ajax.js';
import { deepSetValue, generateUUID, logError, logInfo } from '../src/utils.js';
import { getStorageManager } from '../src/storageManager.js';
import { MODULE_TYPE_RTD } from '../src/activities/modules.js';
import { ACTIVITY_REPORT_ANALYTICS } from '../src/activities/activities.js';
import { activityParams } from '../src/activities/activityParams.js';
import { isActivityAllowed } from '../src/activities/rules.js';

const SUBMODULE_NAME = 'transfonSecurity';
const GVLID = 1370;
const LOG_PREFIX = 'TransfonSecurity RTD:';
const EDGE_URL = 'https://edge.waf360.com';
const DEFAULT_TIMEOUT = 1000;
const TARGETING_KEY = 'tss_qs';
// Project licenses are 10 lowercase hex characters, e.g. abcdef1234.
const LICENSE_ID = /^[0-9a-f]{10}$/;
const UID_COOKIE = '__unis_uid';
const UID_DAYS = 301;

export const storage = getStorageManager({ moduleType: MODULE_TYPE_RTD, moduleName: SUBMODULE_NAME });

const UA_BOT = /bot|crawl|slurp|spider|mediapartners|headless|puppeteer|playwright|selenium|phantomjs|snap-prefetch|remotasks|woorank|uptime\.com|facebookexternalhit|facebookcatalog|whatsapp|chatgpt-user|anthropic-ai|google-inspectiontool|google-read-aloud|feedfetcher|ia_archiver|yeti|embedly|vkshare|pinterest/i;
const AUTOMATION_GLOBALS = [
  '__webdriver_evaluate', '__webdriver_script_fn', '__webdriver_script_func', '__webdriver_script_function',
  '__webdriver_unwrapped', '__fxdriver_evaluate', '__fxdriver_unwrapped', '__driver_evaluate', '__driver_unwrapped',
  '__selenium_evaluate', '__selenium_unwrapped', '_Selenium_IDE_Recorder', 'callSelenium', 'domAutomation',
  'domAutomationController', '__playwright__', '__pw_manual', '__PW_inspect', '__puppeteer_evaluation_script__',
  '__nightmare', '_phantom', 'callPhantom'
];

let verdictPromise = null;
let verdict = null;

export function reset() {
  verdictPromise = null;
  verdict = null;
}

function getParams(config) {
  const params = config?.params || {};
  return {
    licenseId: typeof params.licenseId === 'string' ? params.licenseId.trim() : '',
    blockIvt: params.blockIvt === true,
    timeout: Number(params.timeout) > 0 ? Number(params.timeout) : DEFAULT_TIMEOUT
  };
}

function isSoftwareRenderer() {
  const webgl = document.createElement('canvas').getContext('webgl');
  const info = webgl && webgl.getExtension('WEBGL_debug_renderer_info');
  if (!info) {
    return false;
  }
  const vendor = webgl.getParameter(info.UNMASKED_VENDOR_WEBGL) || '';
  const renderer = webgl.getParameter(info.UNMASKED_RENDERER_WEBGL) || '';
  return renderer.indexOf('SwiftShader') > -1 || (vendor === 'Brian Paul' && renderer === 'Mesa OffScreen');
}

function hasAutomationGlobals() {
  if (AUTOMATION_GLOBALS.some((key) => key in window || key in document)) {
    return true;
  }
  return Object.getOwnPropertyNames(document).some((key) => key.indexOf('$cdc_') === 0);
}

function detectStrongBot() {
  try {
    if (navigator.webdriver) {
      return 'webdriver';
    }
    if (navigator.userAgent === '' || UA_BOT.test(navigator.userAgent)) {
      return 'ua';
    }
    if (isSoftwareRenderer()) {
      return 'gpu';
    }
    if (hasAutomationGlobals()) {
      return 'automation';
    }
  } catch (e) {}
  return '';
}

export const internals = { detectStrongBot };

function hasSecurityTag() {
  return typeof window._waf360?.check === 'function' ||
    Array.isArray(window._waf360?.q) ||
    !!document.getElementById('waf360-tag');
}

function fetchFromTag(licenseId, timeout) {
  const tagWait = Math.round(timeout / 2);
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        fetchFromEdge(licenseId, timeout - tagWait).then(resolve, reject);
      }
    }, tagWait);
    const onVerdict = (data) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(data);
      }
    };
    if (typeof window._waf360?.check === 'function') {
      window._waf360.check(onVerdict);
    } else {
      window._waf360 = window._waf360 || {};
      window._waf360.q = window._waf360.q || [];
      window._waf360.q.push(['check', onVerdict]);
    }
  });
}

function fetchFromEdge(licenseId, timeout) {
  return new Promise((resolve, reject) => {
    const url = `${EDGE_URL}/tag/${encodeURIComponent(licenseId)}/c/`;
    ajaxBuilder(timeout, {}, MODULE_TYPE_RTD, SUBMODULE_NAME)(url, {
      success(response) {
        try {
          resolve(JSON.parse(response));
        } catch (e) {
          reject(e);
        }
      },
      error(err) {
        reject(err);
      }
    }, null, { method: 'GET', withCredentials: true });
  });
}

function getUid() {
  let uid = storage.getCookie(UID_COOKIE);
  if (!uid) {
    uid = generateUUID();
    const expires = new Date(Date.now() + UID_DAYS * 864e5).toUTCString();
    storage.setCookie(UID_COOKIE, uid, expires, 'Lax');
  }
  return uid;
}

export function buildPageView(licenseId, data, clientReason) {
  return [{
    app: licenseId,
    timestamp: new Date().toISOString(),
    event: 'pv',
    uuid: getUid(),
    kv: {
      src: 'prebid',
      host: window.location.hostname,
      title: document.title,
      url: window.location.href,
      ref: document.referrer,
      ua: navigator.userAgent,
      pv: generateUUID()
    },
    c: {
      cb: clientReason ? 1 : 0,
      cr: clientReason || '',
      block: !!data?.block,
      ik: !!data?.ik,
      kc: data?.kc || ''
    }
  }];
}

function sendPageView(licenseId, data, clientReason) {
  if (!isActivityAllowed(ACTIVITY_REPORT_ANALYTICS, activityParams(MODULE_TYPE_RTD, SUBMODULE_NAME))) {
    return;
  }
  ajaxBuilder(DEFAULT_TIMEOUT, {}, MODULE_TYPE_RTD, SUBMODULE_NAME)(`${EDGE_URL}/tag/v1/log`, { success() {}, error() {} },
    JSON.stringify(buildPageView(licenseId, data, clientReason)), { method: 'POST', contentType: 'text/plain', keepalive: true });
}

export function getTssQs(data) {
  return data?.qs === false ? 0 : 1;
}

export function shouldBlock(data) {
  return getTssQs(data) === 0 || data?.block === true;
}

function init(config) {
  const { licenseId, timeout } = getParams(config);
  if (!LICENSE_ID.test(licenseId)) {
    logError(`${LOG_PREFIX} params.licenseId must be a 10 character Transfon Security license, e.g. abcdef1234`);
    return false;
  }
  reset();
  const fromTag = hasSecurityTag();
  const clientReason = internals.detectStrongBot();
  verdictPromise = (fromTag ? fetchFromTag(licenseId, timeout) : fetchFromEdge(licenseId, timeout))
    .then((data) => {
      const server = data && typeof data === 'object' ? data : null;
      if (!fromTag && server) {
        sendPageView(licenseId, server, clientReason);
      }
      verdict = clientReason ? { ...server, qs: false } : server;
      return verdict;
    })
    .catch((err) => {
      logInfo(`${LOG_PREFIX} verdict unavailable`, err);
      verdict = clientReason ? { qs: false } : null;
      return verdict;
    });
  return true;
}

function getBidRequestData(reqBidsConfigObj, callback, config) {
  const { blockIvt } = getParams(config);
  if (!verdictPromise) {
    callback();
    return;
  }
  verdictPromise.then((data) => {
    if (data) {
      deepSetValue(reqBidsConfigObj, `ortb2Fragments.global.site.ext.data.${TARGETING_KEY}`, getTssQs(data));
      if (blockIvt && shouldBlock(data)) {
        (reqBidsConfigObj.adUnits || []).forEach((adUnit) => {
          adUnit.bids = [];
        });
        logInfo(`${LOG_PREFIX} bid requests removed (${getTssQs(data) === 0 ? 'tss_qs = 0' : 'block rule'})`);
      }
    }
    callback();
  });
}

function getTargetingData(adUnitCodes) {
  if (!verdict) {
    return {};
  }
  const value = String(getTssQs(verdict));
  return adUnitCodes.reduce((targeting, code) => {
    targeting[code] = { [TARGETING_KEY]: value };
    return targeting;
  }, {});
}

export const transfonSecuritySubmodule = {
  name: SUBMODULE_NAME,
  gvlid: GVLID,
  init,
  getBidRequestData,
  getTargetingData
};

submodule('realTimeData', transfonSecuritySubmodule);
