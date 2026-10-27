# Transfon Security RTD Provider

## Overview

    Module Name: Transfon Security Rtd Provider
    Module Type: Rtd Provider
    Maintainer: support@transfon.com

The Transfon Security module checks each page view against the Transfon Security traffic quality service (bots, data centre, proxy, VPN and Tor networks, header and session anomalies) before the auction. It passes the verdict to bidders and the ad server, and can optionally stop bid requests for invalid traffic.

Page views are reported to the Transfon Security project, where the traffic quality breakdown is available in the Transfon Security dashboard.

A Transfon Security project license is required: create a project in [Transfon Security](https://www.transfon.com/security/prebid-rtd) and copy its license (10 characters, for example `abcdef1234`) from the Installation page.

## Integration

Build Prebid.js with the RTD core module and this provider:

```bash
gulp build --modules=rtdModule,transfonSecurityRtdProvider,...
```

Configure the provider:

```javascript
pbjs.setConfig({
  realTimeData: {
    auctionDelay: 300,
    dataProviders: [{
      name: 'transfonSecurity',
      waitForIt: true,
      params: {
        licenseId: 'YOUR_LICENSE',
        blockIvt: false
      }
    }]
  }
});
```

## Parameters

| Name | Type | Description | Default |
|:--|:--|:--|:--|
| name | String | Must be `transfonSecurity` | |
| waitForIt | Boolean | Wait for the verdict (up to `auctionDelay`) before the auction starts | `false` |
| params.licenseId | String | Transfon Security project license, 10 lowercase hex characters (required) | |
| params.blockIvt | Boolean | Remove all bid requests when `tss_qs` is `0` or the page view matches the block rules set in the Transfon Security project | `false` |
| params.timeout | Number | Verdict timeout in milliseconds; when the Transfon Security tag is on the page but has not answered after half of it, the module asks the edge itself with the rest | `1000` |

## Output

| Where | Key | Values |
|:--|:--|:--|
| Global first party data | `ortb2.site.ext.data.tss_qs` | `1` valid traffic, `0` invalid traffic (project block rules do not change it) |
| Ad server targeting (per ad unit) | `tss_qs` | `"1"`, `"0"` |

The page is also marked invalid when the browser shows an unambiguous automation signal (`navigator.webdriver`, automation framework globals, a bot user agent or a software WebGL renderer).

If the verdict is not available in time, or the request fails, and no browser signal fired, the auction continues unchanged and no signal is added.

When the Transfon Security tag is also on the page, the module reuses the tag's verdict and does not send its own page view.

The page view is only sent when Prebid's activity controls allow this module to report analytics (TCF Purpose 7 for vendor 1370 when GDPR enforcement is on).

## Privacy

The module is registered under TCF Global Vendor List ID 1370. The verdict request carries cookies, and a first party visitor id (`__unis_uid`) is stored, only when device access is allowed for this vendor. Without consent the verdict is still computed from the request itself.

## Testing

```bash
gulp test-only --file test/spec/modules/transfonSecurityRtdProvider_spec.js
```
