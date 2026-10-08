# Tab Volume Booster

Version 2.0.4 is a Manifest V3 extension for Chrome and Brave that adjusts website audio/video players automatically using saved settings.

## Features

- Volume from 0% to 1000%, with 100%, 250%, 500%, 750%, and 1000% quick presets.
- Adjustments of ±10% and ±100%, plus Reset.
- Optional Smooth Audio peak protection and a separate Audio Leveler.
- Five-band EQ, audio presets, stereo balance, and custom settings.
- Per-site, per-tab, or global audio preferences.
- System, light, dark, and custom themes.
- Saved per-site and global settings apply after browser restarts without opening the extension.

## Install for development

Download and extract the [Chrome Web Store package](dist/Tab-Volume-Booster-v2.0.4-Chrome-Web-Store.zip). Open chrome://extensions or brave://extensions, enable Developer mode, and choose Load unpacked on the extracted folder containing manifest.json. Refresh existing website tabs once after installing or reloading.

Per-tab preferences last for the browser session. Per-site and global preferences persist until changed or reset. Browser playback policies still apply; use the website's Play button when autoplay is blocked.

## Privacy

Audio processing and stored preferences stay in the browser. Website addresses are read to apply per-site settings; audio is processed transiently and is not recorded or uploaded. See the [privacy policy](PRIVACY.md) for the full explanation.

## Compatibility and testing

Requires Chromium 116 or later. Automatic processing, full Brave restart persistence, and real YouTube playback were verified. Embedded players, original-audio bypass, and production peak protection were also tested. Netflix subscriber playback has not been verified.

Some cross-origin players, players already attached to another Web Audio source, and audio generated outside audio/video elements cannot be processed. Higher boosts on already-loud recordings trade dynamics for average loudness and cannot repair distortion already in the source.
