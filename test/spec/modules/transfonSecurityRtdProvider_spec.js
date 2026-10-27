import { expect } from 'chai';
import { server } from 'test/mocks/xhr.js';
import { registerActivityControl } from 'src/activities/rules.js';
import { ACTIVITY_REPORT_ANALYTICS } from 'src/activities/activities.js';
import {
  buildPageView,
  getTssQs,
  internals,
  reset,
  shouldBlock,
  storage,
  transfonSecuritySubmodule as submodule
} from '../../../modules/transfonSecurityRtdProvider.js';

const LICENSE = 'abcdef1234';
const config = (params = {}) => ({ name: 'transfonSecurity', params: { licenseId: LICENSE, ...params } });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const calls = () => server.requests.map((r) => ({ url: r.url, data: r.requestBody, method: r.method, withCredentials: r.withCredentials }));

function reqBids() {
  return {
    adUnits: [
      { code: 'div-1', bids: [{ bidder: 'appnexus' }, { bidder: 'rubicon' }] },
      { code: 'div-2', bids: [{ bidder: 'appnexus' }] }
    ],
    ortb2Fragments: { global: {}, bidder: {} }
  };
}

describe('transfonSecurityRtdProvider', () => {
  let sandbox, response;

  // Answer pending verdict requests with the current response, or fail them.
  function answer() {
    server.requests.filter((r) => r.method === 'GET' && !r.answered).forEach((r) => {
      r.answered = true;
      if (response instanceof Error) {
        r.error();
      } else {
        r.respond(200, { 'Content-Type': 'application/json' }, JSON.stringify(response));
      }
    });
  }

  function start(cfg) {
    const ok = submodule.init(cfg);
    answer();
    return ok;
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    response = { qs: true, ib: false, block: false };
    sandbox.stub(storage, 'getCookie').returns(null);
    sandbox.stub(storage, 'setCookie');
    sandbox.stub(internals, 'detectStrongBot').returns('');
    delete window._waf360;
    reset();
  });

  afterEach(() => {
    sandbox.restore();
    delete window._waf360;
    reset();
  });

  describe('init', () => {
    it('declares the module name and gvlid', () => {
      expect(submodule.name).to.equal('transfonSecurity');
      expect(submodule.gvlid).to.equal(1370);
    });

    it('fails without a licenseId', () => {
      expect(start({ params: {} })).to.equal(false);
      expect(calls()).to.have.length(0);
    });

    it('fails with a malformed licenseId', () => {
      ['12345', 'abcdef123', 'abcdef12345', 'ABCDEF1234', 'abcdef123g', 'project-01'].forEach((licenseId) => {
        expect(start({ params: { licenseId } })).to.equal(false);
      });
      expect(calls()).to.have.length(0);
    });

    it('accepts a licenseId with surrounding spaces', () => {
      expect(start({ params: { licenseId: ' abcdef1234 ' } })).to.equal(true);
    });

    it('requests the verdict with credentials and logs one page view', async () => {
      expect(start(config())).to.equal(true);
      await flush();
      expect(calls()[0].url).to.equal(`https://edge.waf360.com/tag/${LICENSE}/c/`);
      expect(calls()[0]).to.include({ method: 'GET', withCredentials: true });
      expect(calls()[1].url).to.equal('https://edge.waf360.com/tag/v1/log');
      const events = JSON.parse(calls()[1].data);
      expect(events[0]).to.include({ app: LICENSE, event: 'pv' });
      expect(events[0].kv.src).to.equal('prebid');
    });

    it('skips the page view when analytics reporting is not allowed', async () => {
      const unregister = registerActivityControl(ACTIVITY_REPORT_ANALYTICS, 'test', (params) =>
        params.componentName === 'transfonSecurity' ? { allow: false } : undefined);
      try {
        start(config());
        await flush();
        expect(calls()).to.have.length(1);
        expect(calls()[0].url).to.equal(`https://edge.waf360.com/tag/${LICENSE}/c/`);
      } finally {
        unregister();
      }
    });

    it('reuses the Transfon Security tag verdict without extra requests', async () => {
      window._waf360 = { check: (cb) => cb({ qs: false }) };
      start(config());
      const req = reqBids();
      await new Promise((resolve) => submodule.getBidRequestData(req, resolve, config()));
      expect(calls()).to.have.length(0);
      expect(req.ortb2Fragments.global.site.ext.data.tss_qs).to.equal(0);
    });
  });

  describe('browser signals', () => {
    it('marks invalid and reports cb when a strong bot signal fires', async () => {
      internals.detectStrongBot.returns('webdriver');
      start(config({ blockIvt: true }));
      const req = reqBids();
      await new Promise((resolve) => submodule.getBidRequestData(req, resolve, config({ blockIvt: true })));
      expect(req.ortb2Fragments.global.site.ext.data.tss_qs).to.equal(0);
      expect(req.adUnits[0].bids).to.have.length(0);
      expect(JSON.parse(calls()[1].data)[0].c).to.include({ cb: 1, cr: 'webdriver' });
    });

    it('still marks invalid when the verdict request fails', async () => {
      internals.detectStrongBot.returns('webdriver');
      response = new Error('down');
      start(config());
      await flush();
      expect(submodule.getTargetingData(['div-1'], config())).to.deep.equal({ 'div-1': { tss_qs: '0' } });
    });

    it('applies on top of the Transfon Security tag verdict', async () => {
      internals.detectStrongBot.returns('webdriver');
      window._waf360 = { check: (cb) => cb({ qs: true }) };
      start(config());
      await flush();
      expect(submodule.getTargetingData(['div-1'], config())).to.deep.equal({ 'div-1': { tss_qs: '0' } });
      expect(calls()).to.have.length(0);
    });

    it('detects the automated test browser', () => {
      internals.detectStrongBot.restore();
      expect(['webdriver', 'ua']).to.include(internals.detectStrongBot());
    });
  });

  describe('Transfon Security tag loading after Prebid', () => {
    let tagEl;
    afterEach(() => {
      if (tagEl) {
        tagEl.remove();
        tagEl = null;
      }
    });

    it('queues a check for the tag and sends no page view', async () => {
      tagEl = document.createElement('div');
      tagEl.id = 'waf360-tag';
      document.body.appendChild(tagEl);
      start(config());
      expect(window._waf360.q).to.have.length(1);
      const [event, cb] = window._waf360.q[0];
      expect(event).to.equal('check');
      cb({ qs: false });
      await flush();
      expect(submodule.getTargetingData(['div-1'], config())).to.deep.equal({ 'div-1': { tss_qs: '0' } });
      expect(calls()).to.have.length(0);
    });

    it('falls back to the edge without a page view when the tag never answers', async () => {
      window._waf360 = { q: [] };
      start(config({ timeout: 20 }));
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(calls()).to.have.length(1);
      expect(calls()[0].url).to.equal(`https://edge.waf360.com/tag/${LICENSE}/c/`);
      answer();
      await flush();
      expect(submodule.getTargetingData(['div-1'], config())).to.deep.equal({ 'div-1': { tss_qs: '1' } });
    });
  });

  describe('getBidRequestData', () => {
    it('adds tss_qs = 1 for valid traffic and keeps bids', async () => {
      start(config({ blockIvt: true }));
      const req = reqBids();
      await new Promise((resolve) => submodule.getBidRequestData(req, resolve, config({ blockIvt: true })));
      expect(req.ortb2Fragments.global.site.ext.data.tss_qs).to.equal(1);
      expect(req.adUnits[0].bids).to.have.length(2);
    });

    it('adds tss_qs = 0 and keeps bids when blockIvt is off', async () => {
      response = { qs: false, ib: true };
      start(config());
      const req = reqBids();
      await new Promise((resolve) => submodule.getBidRequestData(req, resolve, config()));
      expect(req.ortb2Fragments.global.site.ext.data.tss_qs).to.equal(0);
      expect(req.adUnits[0].bids).to.have.length(2);
    });

    it('removes bids for invalid traffic when blockIvt is on', async () => {
      response = { qs: false, ic: true };
      start(config({ blockIvt: true }));
      const req = reqBids();
      await new Promise((resolve) => submodule.getBidRequestData(req, resolve, config({ blockIvt: true })));
      expect(req.adUnits.every((u) => u.bids.length === 0)).to.equal(true);
    });

    it('removes bids when the license block rules match but keeps tss_qs = 1', async () => {
      response = { qs: true, block: true };
      start(config({ blockIvt: true }));
      const req = reqBids();
      await new Promise((resolve) => submodule.getBidRequestData(req, resolve, config({ blockIvt: true })));
      expect(req.adUnits[1].bids).to.have.length(0);
      expect(req.ortb2Fragments.global.site.ext.data.tss_qs).to.equal(1);
    });

    it('does not signal block rule matches as invalid traffic', async () => {
      response = { qs: true, block: true };
      start(config());
      const req = reqBids();
      await new Promise((resolve) => submodule.getBidRequestData(req, resolve, config()));
      expect(req.ortb2Fragments.global.site.ext.data.tss_qs).to.equal(1);
      expect(req.adUnits[0].bids).to.have.length(2);
      expect(submodule.getTargetingData(['div-1'], config())).to.deep.equal({ 'div-1': { tss_qs: '1' } });
    });

    it('fails open when the verdict request errors', async () => {
      response = new Error('down');
      start(config({ blockIvt: true }));
      const req = reqBids();
      await new Promise((resolve) => submodule.getBidRequestData(req, resolve, config({ blockIvt: true })));
      expect(req.ortb2Fragments.global).to.deep.equal({});
      expect(req.adUnits[0].bids).to.have.length(2);
      expect(calls()).to.have.length(1);
    });
  });

  describe('getTargetingData', () => {
    it('returns nothing before the verdict', () => {
      expect(submodule.getTargetingData(['div-1'], config())).to.deep.equal({});
    });

    it('sets tss_qs per ad unit', async () => {
      response = { qs: false };
      start(config());
      await flush();
      expect(submodule.getTargetingData(['div-1', 'div-2'], config())).to.deep.equal({
        'div-1': { tss_qs: '0' },
        'div-2': { tss_qs: '0' }
      });
    });
  });

  describe('helpers', () => {
    it('getTssQs and shouldBlock', () => {
      expect(getTssQs({ qs: true })).to.equal(1);
      expect(getTssQs({ qs: false })).to.equal(0);
      expect(getTssQs({ qs: true, block: true })).to.equal(1);
      expect(getTssQs(null)).to.equal(1);
      expect(shouldBlock({ qs: true, block: true })).to.equal(true);
      expect(shouldBlock({ qs: false })).to.equal(true);
      expect(shouldBlock({ qs: true })).to.equal(false);
      expect(shouldBlock(null)).to.equal(false);
    });

    it('buildPageView keeps an existing visitor id', () => {
      storage.getCookie.returns('uid-1');
      const [event] = buildPageView(LICENSE, { block: true, ik: true, kc: 'r' }, '');
      expect(event.uuid).to.equal('uid-1');
      expect(event.c).to.deep.equal({ cb: 0, cr: '', block: true, ik: true, kc: 'r' });
      expect(storage.setCookie.called).to.equal(false);
    });
  });
});
