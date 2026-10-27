import { expect } from 'chai';
import { loadExternalScriptStub } from 'test/mocks/adloaderStub.js';
import { registerActivityControl } from 'src/activities/rules.js';
import { ACTIVITY_ACCESS_DEVICE, ACTIVITY_REPORT_ANALYTICS } from 'src/activities/activities.js';
import { config as pbjsConfig } from 'src/config.js';
import {
  getTssQs,
  internals,
  reset,
  shouldBlock,
  transfonSecuritySubmodule as submodule
} from '../../../modules/transfonSecurityRtdProvider.js';

const LICENSE = 'abcdef1234';
const RTD_TAG_URL = 'https://tag.waf360.com/tag/prebid/rtd.js';
const config = (params = {}) => ({ name: 'transfonSecurity', params: { licenseId: LICENSE, ...params } });
const awaited = (params = {}) => ({ ...config(params), waitForIt: true });
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function reqBids() {
  return {
    adUnits: [
      { code: 'div-1', bids: [{ bidder: 'appnexus' }, { bidder: 'rubicon' }] },
      { code: 'div-2', bids: [{ bidder: 'appnexus' }] }
    ],
    ortb2Fragments: { global: {}, bidder: {} }
  };
}

const auction = (cfg) => {
  const req = reqBids();
  return new Promise((resolve) => submodule.getBidRequestData(req, resolve, cfg)).then(() => req);
};

describe('transfonSecurityRtdProvider', () => {
  let sandbox, rtd;

  function rtdTag(response) {
    rtd = {
      init: sinon.spy(),
      check: sinon.spy((cb) => { if (response !== undefined) cb(response); }),
      report: sinon.spy()
    };
    window._waf360rtd = rtd;
  }

  beforeEach(() => {
    sandbox = sinon.createSandbox();
    sandbox.stub(internals, 'reportWait').value(20);
    delete window._waf360;
    delete window._waf360rtd;
    reset();
  });

  afterEach(() => {
    pbjsConfig.resetConfig();
    sandbox.restore();
    delete window._waf360;
    delete window._waf360rtd;
    reset();
  });

  describe('init', () => {
    it('declares the module name and gvlid', () => {
      expect(submodule.name).to.equal('transfonSecurity');
      expect(submodule.gvlid).to.equal(1370);
    });

    it('fails without a valid licenseId', () => {
      [undefined, '12345', 'abcdef123', 'abcdef12345', 'ABCDEF1234', 'abcdef123g'].forEach((licenseId) => {
        expect(submodule.init({ params: { licenseId } })).to.equal(false);
      });
      expect(loadExternalScriptStub.called).to.equal(false);
    });

    it('accepts a licenseId with surrounding spaces', () => {
      rtdTag({ qs: true });
      expect(submodule.init(config({ licenseId: ' abcdef1234 ' }))).to.equal(true);
    });

    it('loads the Prebid tag and passes the license and storage consent', () => {
      rtdTag({ qs: true });
      submodule.init(config());
      expect(loadExternalScriptStub.calledOnce).to.equal(true);
      expect(loadExternalScriptStub.firstCall.args.slice(0, 3)).to.deep.equal([RTD_TAG_URL, 'rtd', 'transfonSecurity']);
      expect(rtd.init.firstCall.args[0]).to.deep.equal({ license: LICENSE, storage: true });
    });

    it('passes storage false when device access is not allowed', () => {
      const unregister = registerActivityControl(ACTIVITY_ACCESS_DEVICE, 'test', (params) =>
        params.componentName === 'transfonSecurity' ? { allow: false } : undefined);
      try {
        rtdTag({ qs: true });
        submodule.init(config());
        expect(rtd.init.firstCall.args[0].storage).to.equal(false);
      } finally {
        unregister();
      }
    });

    it('queues calls until the Prebid tag loads', () => {
      submodule.init(config());
      expect(window._waf360rtd.q.map(([name]) => name)).to.deep.equal(['init', 'check']);
    });

    it('uses the Transfon Security tag already on the page instead of loading one', async () => {
      window._waf360 = { check: (cb) => cb({ qs: false }), send: sinon.spy() };
      submodule.init(config());
      await flush();
      expect(loadExternalScriptStub.called).to.equal(false);
      expect(submodule.getTargetingData(['div-1'])).to.deep.equal({ 'div-1': { tss_qs: '0' } });
    });
  });

  describe('getBidRequestData', () => {
    it('adds tss_qs = 1 for valid traffic and keeps bids', async () => {
      rtdTag({ qs: true });
      submodule.init(config({ blockIvt: true }));
      const req = await auction(config({ blockIvt: true }));
      expect(req.ortb2Fragments.global.site.ext.data.tss_qs).to.equal(1);
      expect(req.adUnits[0].bids).to.have.length(2);
    });

    it('adds tss_qs = 0 and keeps bids when blockIvt is off', async () => {
      rtdTag({ qs: false });
      submodule.init(config());
      const req = await auction(config());
      expect(req.ortb2Fragments.global.site.ext.data.tss_qs).to.equal(0);
      expect(req.adUnits[0].bids).to.have.length(2);
    });

    it('removes bids for invalid traffic when blockIvt is on', async () => {
      rtdTag({ qs: false });
      submodule.init(config({ blockIvt: true }));
      const req = await auction(config({ blockIvt: true }));
      expect(req.adUnits.every((u) => u.bids.length === 0)).to.equal(true);
    });

    it('removes bids when the block rules match but keeps tss_qs = 1', async () => {
      rtdTag({ qs: true, block: true });
      submodule.init(config({ blockIvt: true }));
      const req = await auction(config({ blockIvt: true }));
      expect(req.adUnits[1].bids).to.have.length(0);
      expect(req.ortb2Fragments.global.site.ext.data.tss_qs).to.equal(1);
    });

    it('fails open when no verdict arrives in time', async () => {
      rtdTag();
      submodule.init(config({ blockIvt: true, timeout: 10 }));
      const req = await auction(config({ blockIvt: true }));
      expect(req.ortb2Fragments.global).to.deep.equal({});
      expect(req.adUnits[0].bids).to.have.length(2);
    });

    it('ignores a response without a verdict', async () => {
      rtdTag({ block: false });
      submodule.init(config());
      const req = await auction(config());
      expect(req.ortb2Fragments.global).to.deep.equal({});
    });
  });

  describe('getTargetingData', () => {
    it('returns nothing before the verdict', () => {
      expect(submodule.getTargetingData(['div-1'])).to.deep.equal({});
    });

    it('sets tss_qs per ad unit', async () => {
      rtdTag({ qs: false });
      submodule.init(config());
      await flush();
      expect(submodule.getTargetingData(['div-1', 'div-2'])).to.deep.equal({
        'div-1': { tss_qs: '0' },
        'div-2': { tss_qs: '0' }
      });
    });
  });

  describe('reporting', () => {
    it('reports the first auction once', async () => {
      rtdTag({ qs: false });
      submodule.init(config({ blockIvt: true }));
      await flush();
      await auction(awaited({ blockIvt: true }));
      await auction(awaited({ blockIvt: true }));
      await wait(40);
      expect(rtd.report.calledOnce).to.equal(true);
      expect(rtd.report.firstCall.args[0]).to.include({ src: 'prebid', pa: '1', vs: 'ok', qs: '0', bv: '1', bi: '1', ad: '0' });
    });

    it('marks a verdict that arrives after auctionDelay as late', async () => {
      pbjsConfig.setConfig({ realTimeData: { auctionDelay: 10 } });
      let answer;
      rtd = { init: sinon.spy(), check: (cb) => { answer = cb; }, report: sinon.spy() };
      window._waf360rtd = rtd;
      submodule.init(config({ blockIvt: true }));
      const pending = auction(awaited({ blockIvt: true }));
      await wait(30);
      answer({ qs: false });
      await pending;
      expect(rtd.report.firstCall.args[0]).to.include({ vs: 'late', qs: '', bi: '0', ad: '10' });
    });

    it('marks a verdict that is not awaited as late', async () => {
      rtdTag({ qs: true });
      submodule.init(config());
      await auction(config());
      expect(rtd.report.firstCall.args[0]).to.include({ vs: 'late', qs: '' });
    });

    it('reports a missing verdict as none', async () => {
      rtdTag();
      submodule.init(config({ timeout: 10 }));
      await auction(awaited());
      expect(rtd.report.firstCall.args[0]).to.include({ pa: '1', vs: 'none', qs: '' });
    });

    it('reports without an auction after the wait', async () => {
      rtdTag({ qs: true });
      submodule.init(config());
      await flush();
      expect(rtd.report.called).to.equal(false);
      await wait(40);
      expect(rtd.report.firstCall.args[0]).to.include({ pa: '0', vs: '', qs: '', bv: '', bi: '' });
    });

    it('skips the report when analytics reporting is not allowed', async () => {
      const unregister = registerActivityControl(ACTIVITY_REPORT_ANALYTICS, 'test', (params) =>
        params.componentName === 'transfonSecurity' ? { allow: false } : undefined);
      try {
        rtdTag({ qs: true });
        submodule.init(config());
        await auction(awaited());
        expect(rtd.report.called).to.equal(false);
      } finally {
        unregister();
      }
    });

    it('sends an auction event through the Transfon Security tag on the page', async () => {
      window._waf360 = { check: (cb) => cb({ qs: true }), send: sinon.spy() };
      submodule.init(config());
      await flush();
      await auction(awaited());
      expect(window._waf360.send.firstCall.args[0]).to.equal('auction');
      expect(window._waf360.send.firstCall.args[1]).to.include({ src: 'prebid', pa: '1', vs: 'ok', qs: '1' });
    });

    it('sends nothing through the Transfon Security tag without an auction', async () => {
      window._waf360 = { check: (cb) => cb({ qs: true }), send: sinon.spy() };
      submodule.init(config());
      await wait(40);
      expect(window._waf360.send.called).to.equal(false);
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
  });
});
