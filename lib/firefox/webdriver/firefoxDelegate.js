'use strict';

const harBuilder = require('../../support/har/');
const log = require('intel').getLogger('browsertime.firefox');
const fs = require('fs');
const { promisify } = require('util');
const rename = promisify(fs.rename);
const pathToFolder = require('../../support/pathToFolder');
const path = require('path');
const { isAndroidConfigured, createAndroidConnection } = require('../../android');
const geckoProfilerDefaults = require('../geckoProfilerDefaults');

class FirefoxDelegate {
  constructor(storageManager, options) {
    // Lets keep this and hope that we in the future will have HAR for FF again
    this.skipHar = options.skipHar;
    this.baseDir = storageManager.directory;
    this.storageManager = storageManager;
    this.includeResponseBodies = options.firefox
      ? options.firefox.includeResponseBodies
      : 'none';
    this.firefoxConfig = options.firefox || {};
    this.options = options;
    // We keep track of all alias and URLs
    this.aliasAndUrl = {};
  }

  async onStart() {
    this.hars = [];
  }

  async onStartIteration(runner) {
    if (this.firefoxConfig.geckoProfiler) {
      let chosenFeatures = this.firefoxConfig.geckoProfilerParams.features.split(',');
      let featureString = '["' + chosenFeatures.join('","') + '"]';

      let chosenThreads = this.firefoxConfig.geckoProfilerParams.threads.split(',');
      let threadString = '["' + chosenThreads.join('","') + '"]';

      let interval = this.firefoxConfig.geckoProfilerParams.interval;

      // Set platform specific sampling intervals if not explicitly specified.
      if (
        this.firefoxConfig.geckoProfiler &&
        !this.firefoxConfig.geckoProfilerParams.interval
      ) {
        interval = isAndroidConfigured(this.options)
          ? geckoProfilerDefaults.android_sampling_interval
          : geckoProfilerDefaults.desktop_sampling_interval;
      }

      let bufferSize = this.firefoxConfig.geckoProfilerParams.bufferSize;

      // Firefox 69 and above has a slightly different API for StartProfiler
      const parameterLength = await runner.runPrivilegedScript(
        'return Services.profiler.StartProfiler.length;',
        'Get StartProfiler.length'
      );

      let script;
      if (parameterLength === 7) {
        script = `Services.profiler.StartProfiler(${bufferSize},${interval},${featureString},
        ${chosenFeatures.length},${threadString},${chosenThreads.length});`;
      } else if (parameterLength === 5) {
        script = `Services.profiler.StartProfiler(${bufferSize},${interval},${featureString},${threadString});`;
      } else {
        log.error('Unknown Gecko Profiler API');
      }

      log.info('Start GeckoProfiler.');
      await runner.runPrivilegedScript(script, 'Start GeckoProfiler');
    }
  }

  async onStopIteration() {}

  async clear() {}

  async onCollect(runner, index, result) {
    if (this.firefoxConfig.collectMozLog) {
      await rename(
        `${this.baseDir}/moz_log.txt`,
        path.join(
          this.baseDir,
          pathToFolder(result.url, this.options),
          `moz_log-${index}.txt`
        )
      );
      // TODO clear the original log file!
    }

    if (this.firefoxConfig.geckoProfiler) {
      let profileDir = await this.storageManager.createSubDataDir(
        pathToFolder(result.url, this.options)
      );
      let destinationFilename = path.join(
        profileDir,
        `geckoProfile-${index}.json`
      );

      let deviceProfileFilename = destinationFilename;
      if (isAndroidConfigured(this.options)) {
        deviceProfileFilename = `/sdcard/geckoProfile-${index}.json`;
      }

      // Must use String.raw or else the backslashes on Windows will be escapes.
      const script = `
      var callback = arguments[arguments.length - 1];
       Services.profiler.dumpProfileToFileAsync(String.raw\`${deviceProfileFilename}\`)
        .then(callback)
        .catch((e) => callback({'error' : e}));
       `;
      await runner.runPrivilegedAsyncScript(script, 'Collect GeckoProfiler');
      log.info('Stop GeckoProfiler.');
      await runner.runPrivilegedScript(
        'Services.profiler.StopProfiler();',
        'Stop GeckoProfiler'
      );

      if (isAndroidConfigured(this.options)) {
        let android = createAndroidConnection(this.options);
        await android.initConnection();
        await android._downloadFile(deviceProfileFilename, destinationFilename);
      }
    }

    if (this.skipHar) {
      return;
    }

    const script = `
    var callback = arguments[arguments.length - 1];
    function triggerExport() {
      HAR.triggerExport()
        .then((result) => {
          // Different handling in FF 60 and 61 :|
          if (result.log) {
            result.log.pages[0].title = document.URL;
          }
          else {
            result.pages[0].title = document.URL;
          }
          // Normalize
          return callback({'har': result.log ? result: {log: result}});
      })
      .catch((e) => callback({'error': e}));
    };
      triggerExport();
    `;

    log.info('Waiting on har-export-trigger to collect the HAR');
    try {
      const harResult = await runner.runAsyncScript(script, 'GET_HAR_SCRIPT');
      if (harResult.har) {
        if (
          this.includeResponseBodies === 'none' ||
          this.includeResponseBodies === 'html'
        ) {
          for (let entry of harResult.har.log.entries) {
            if (this.includeResponseBodies === 'none') {
              delete entry.response.content.text;
            } else if (
              entry.response.content.mimeType &&
              entry.response.content.mimeType.indexOf('text/html') === -1
            ) {
              delete entry.response.content.text;
            }
          }
        }

        if (harResult.har.log.pages.length > 0) {
          // Hack to add the URL from a SPA

          if (result.alias && !this.aliasAndUrl[result.alias]) {
            this.aliasAndUrl[result.alias] = result.url;
            harResult.har.log.pages[0]._url = result.url;
          } else if (result.alias && this.aliasAndUrl[result.alias]) {
            harResult.har.log.pages[0]._url = this.aliasAndUrl[result.alias];
          } else {
            harResult.har.log.pages[0]._url = result.url;
          }
        }

        this.hars.push(harResult.har);
      } else {
        // We got an error from HAR exporter
        log.error(
          'Got an error from HAR Export Trigger ' +
            JSON.stringify(harResult.error)
        );
      }
    } catch (e) {
      log.error('Could not get the HAR from Firefox', e);
    }
  }

  failing(url) {
    if (this.skipHar) {
      return;
    }
    this.hars.push(harBuilder.getEmptyHAR(url, 'Firefox'));
  }

  async onStop() {
    if (!this.skipHar && this.hars.length > 0) {
      return { har: harBuilder.mergeHars(this.hars) };
    } else {
      return {};
    }
  }
}

module.exports = FirefoxDelegate;
