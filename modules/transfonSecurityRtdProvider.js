/**
 * This module adds the Transfon Security traffic quality verdict to the auction.
 * @module modules/transfonSecurityRtdProvider
 * @requires module:modules/realTimeData
 */

import { submodule } from '../src/hook.js';
import { config as pbjsConfig } from '../src/config.js';
import { loadExternalScript } from '../src/adloader.js';
import { deepSetValue, logError, logInfo } from '../src/utils.js';
import { MODULE_TYPE_RTD } from '../src/activities/modules.js';
import { ACTIVITY_ACCESS_DEVICE, ACTIVITY_REPORT_ANALYTICS } from '../src/activities/activities.js';
import { activityParams } from '../src/activities/activityParams.js';
import { isActivityAllowed } from '../src/activities/rules.js';

const SUBMODULE_NAME = 'transfonSecurity';
const GVLID = 1370;
const LOG_PREFIX = 'TransfonSecurity RTD:';
const RTD_TAG_URL = 'https://tag.waf360.com/tag/prebid/rtd.js';
const DEFAULT_TIMEOUT = 1000;
const REPORT_WAIT = 5000;
const TARGETING_KEY = 'tss_qs';
const LICENSE_ID = /^[0-9a-f]{10}$/;

let verdictPromise = null;
let verdict = null;
let page = null;

export const internals = { reportWait: REPORT_WAIT };

export function reset() {
  if (page?.timer) {
    clearTimeout(page.timer);
  }
  verdictPromise = null;
  verdict = null;
  page = null;
}

function getParams(config) {
  const params = config?.params || {};
  return {
    licenseId: typeof params.licenseId === 'string' ? params.licenseId.trim() : '',
    blockIvt: params.blockIvt === true,
    timeout: Number(params.timeout) > 0 ? Number(params.timeout) : DEFAULT_TIMEOUT
  };
}

function allowed(activity) {
  return isActivityAllowed(activity, activityParams(MODULE_TYPE_RTD, SUBMODULE_NAME));
}

function hasSecurityTag() {
  return typeof window._waf360?.check === 'function' || !!document.getElementById('waf360-tag');
}

function queueCall(globalName, name, ...args) {
  const target = window[globalName] = window[globalName] || {};
  if (typeof target[name] === 'function') {
    target[name](...args);
  } else {
    target.q = target.q || [];
    target.q.push([name, ...args]);
  }
}

function securityTag() {
  return {
    check: (callback) => queueCall('_waf360', 'check', callback),
    report: (kv) => {
      if (kv.pa === '1') {
        queueCall('_waf360', 'send', 'auction', kv);
      }
    }
  };
}

function rtdTag(licenseId) {
  queueCall('_waf360rtd', 'init', { license: licenseId, storage: allowed(ACTIVITY_ACCESS_DEVICE) });
  loadExternalScript(RTD_TAG_URL, MODULE_TYPE_RTD, SUBMODULE_NAME);
  return {
    check: (callback) => queueCall('_waf360rtd', 'check', callback),
    report: (kv) => queueCall('_waf360rtd', 'report', kv)
  };
}

function report(auction) {
  if (!page || page.reported) {
    return;
  }
  page.reported = true;
  clearTimeout(page.timer);
  if (!allowed(ACTIVITY_REPORT_ANALYTICS)) {
    return;
  }
  const a = auction || {};
  page.tag.report({
    src: 'prebid',
    pa: auction ? '1' : '0',
    vs: a.status || '',
    vt: String(page.settledAt - page.startedAt),
    ad: auction ? String(a.auctionDelay) : '',
    qs: a.qs || '',
    bv: auction ? (a.blockIvt ? '1' : '0') : '',
    bi: auction ? (a.removed ? '1' : '0') : ''
  });
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
    logError(`${LOG_PREFIX} params.licenseId must be a 10 character Transfon Security license`);
    return false;
  }
  reset();
  const tag = hasSecurityTag() ? securityTag() : rtdTag(licenseId);
  page = { tag, startedAt: Date.now(), settledAt: null, reported: false, timer: null };
  const current = page;
  verdictPromise = new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeout);
    tag.check((data) => {
      clearTimeout(timer);
      resolve(data);
    });
  }).then((data) => {
    current.settledAt = Date.now();
    verdict = data && typeof data.qs === 'boolean' ? data : null;
    if (!verdict) {
      logInfo(`${LOG_PREFIX} verdict unavailable`);
    }
    if (!current.reported) {
      current.timer = setTimeout(() => report(null), internals.reportWait);
    }
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
  const requestedAt = Date.now();
  const settledBefore = page?.settledAt != null;
  const auctionDelay = Number(pbjsConfig.getConfig('realTimeData.auctionDelay')) || 0;
  verdictPromise.then((data) => {
    const late = !settledBefore && (config?.waitForIt !== true || Date.now() - requestedAt > auctionDelay);
    let removed = false;
    if (data) {
      deepSetValue(reqBidsConfigObj, `ortb2Fragments.global.site.ext.data.${TARGETING_KEY}`, getTssQs(data));
      if (blockIvt && shouldBlock(data)) {
        (reqBidsConfigObj.adUnits || []).forEach((adUnit) => {
          adUnit.bids = [];
        });
        removed = true;
        logInfo(`${LOG_PREFIX} bid requests removed (${getTssQs(data) === 0 ? 'tss_qs = 0' : 'block rule'})`);
      }
    }
    report({
      status: !data ? 'none' : (late ? 'late' : 'ok'),
      qs: data && !late ? String(getTssQs(data)) : '',
      auctionDelay,
      blockIvt,
      removed: removed && !late
    });
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
