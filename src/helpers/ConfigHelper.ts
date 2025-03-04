import {
  AppUserConfig, AppConfig, ServerAppPromptConfig,
  ConfigIntegrationKind, ServerAppConfig } from "../models/AppConfig";
import { WindowEnvironmentKind } from "../models/WindowEnvironmentKind";
import { SdkInitError, SdkInitErrorKind } from "../errors/SdkInitError";
import SdkEnvironment from "../managers/SdkEnvironment";
import OneSignalUtils from "../utils/OneSignalUtils";
import Utils from "../context/shared/utils/Utils";
import {
  SERVER_CONFIG_DEFAULTS_SESSION,
  SERVER_CONFIG_DEFAULTS_PROMPT_DELAYS,
  SERVER_CONFIG_DEFAULTS_SLIDEDOWN,
  CONFIG_DEFAULTS_SLIDEDOWN_OPTIONS
} from "../config";
import {
  AppUserConfigCustomLinkOptions,
  AppUserConfigPromptOptions,
  DelayedPromptType,
} from '../models/Prompts';
import TagUtils from '../../src/utils/TagUtils';
import PromptsHelper from './PromptsHelper';
import { ConverterHelper } from "./ConverterHelper";

export enum IntegrationConfigurationKind {
  /**
   * Configuration comes from the dashboard only.
   */
  Dashboard,
  /**
   * Configuration comes from user-provided JavaScript code only.
   */
  JavaScript
}

export interface IntegrationCapabilities {
  configuration: IntegrationConfigurationKind;
}

const MAX_CATEGORIES = 10;

export class ConfigHelper {

  public static async getAppConfig(userConfig: AppUserConfig,
    downloadServerAppConfig: (appId: string) => Promise<ServerAppConfig>): Promise<AppConfig> {
    try {
      if (!userConfig || !userConfig.appId || !OneSignalUtils.isValidUuid(userConfig.appId))
        throw new SdkInitError(SdkInitErrorKind.InvalidAppId);

      const serverConfig = await downloadServerAppConfig(userConfig.appId);
      ConverterHelper.upgradeConfigToVersionTwo(userConfig);
      const appConfig = this.getMergedConfig(userConfig, serverConfig);
      this.checkRestrictedOrigin(appConfig);
      return appConfig;
    }
    catch (e) {
      if (e) {
        if (e.code === 1)
          throw new SdkInitError(SdkInitErrorKind.InvalidAppId);
        else if (e.code === 2)
          throw new SdkInitError(SdkInitErrorKind.AppNotConfiguredForWebPush);
      }
      throw e;
    }
  }

  public static checkRestrictedOrigin(appConfig: AppConfig) {
    if (appConfig.restrictedOriginEnabled) {
      if (SdkEnvironment.getWindowEnv() !== WindowEnvironmentKind.ServiceWorker) {
        if (window.top === window &&
          !Utils.contains(window.location.hostname, ".os.tc") &&
          !Utils.contains(window.location.hostname, ".onesignal.com") &&
          !this.doesCurrentOriginMatchConfigOrigin(appConfig.origin)) {
          throw new SdkInitError(SdkInitErrorKind.WrongSiteUrl, {
            siteUrl: appConfig.origin
          });
        }
      }
    }
  }

  public static doesCurrentOriginMatchConfigOrigin(configOrigin: string): boolean {
    try {
      return location.origin === new URL(configOrigin).origin;
    } catch (e) {
      return false;
    }
  }

  public static getIntegrationCapabilities(integration: ConfigIntegrationKind): IntegrationCapabilities {
    switch (integration) {
      case ConfigIntegrationKind.Custom:
      case ConfigIntegrationKind.WordPress:
        return { configuration: IntegrationConfigurationKind.JavaScript };
      default:
        return { configuration: IntegrationConfigurationKind.Dashboard };
    }
  }

  public static getMergedConfig(userConfig: AppUserConfig, serverConfig: ServerAppConfig): AppConfig {
    const configIntegrationKind = this.getConfigIntegrationKind(serverConfig);

    const subdomain = this.getSubdomainForConfigIntegrationKind(configIntegrationKind, userConfig, serverConfig);
    const allowLocalhostAsSecureOrigin = (
      serverConfig.config.setupBehavior ?
        serverConfig.config.setupBehavior.allowLocalhostAsSecureOrigin :
        userConfig.allowLocalhostAsSecureOrigin
    );
    const isUsingSubscriptionWorkaround = OneSignalUtils.internalIsUsingSubscriptionWorkaround(
      subdomain,
      allowLocalhostAsSecureOrigin
    );

    const mergedUserConfig = this.getUserConfigForConfigIntegrationKind(
      configIntegrationKind, userConfig, serverConfig, isUsingSubscriptionWorkaround);

    return {
      appId: serverConfig.app_id,
      subdomain,
      siteName: serverConfig.config.siteInfo.name,
      origin: serverConfig.config.origin,
      httpUseOneSignalCom: serverConfig.config.http_use_onesignal_com,
      restrictedOriginEnabled: serverConfig.features.restrict_origin && serverConfig.features.restrict_origin.enable,
      metrics: {
        enable: serverConfig.features.metrics.enable,
        mixpanelReportingToken: serverConfig.features.metrics.mixpanel_reporting_token
      },
      safariWebId: serverConfig.config.safari_web_id,
      vapidPublicKey: serverConfig.config.vapid_public_key,
      onesignalVapidPublicKey: serverConfig.config.onesignal_vapid_public_key,
      userConfig: mergedUserConfig,
      enableOnSession: Utils.valueOrDefault(
        serverConfig.features.enable_on_session,
        SERVER_CONFIG_DEFAULTS_SESSION.enableOnSessionForUnsubcribed
      ),
      sessionThreshold: Utils.valueOrDefault(
        serverConfig.features.session_threshold,
        SERVER_CONFIG_DEFAULTS_SESSION.reportingThreshold
      ),
      enableSessionDuration: Utils.valueOrDefault(
        serverConfig.features.web_on_focus_enabled,
        SERVER_CONFIG_DEFAULTS_SESSION.enableOnFocus
      )
    };
  }

  public static getConfigIntegrationKind(serverConfig: ServerAppConfig): ConfigIntegrationKind {
    if (serverConfig.config.integration)
      return serverConfig.config.integration.kind;
    return ConfigIntegrationKind.Custom;
  }

  public static getCustomLinkConfig(serverConfig: ServerAppConfig): AppUserConfigCustomLinkOptions {
    const initialState: AppUserConfigCustomLinkOptions = {
      enabled: false,
      style: "button",
      size: "medium",
      unsubscribeEnabled: false,
      text: {
        explanation: "",
        subscribe: "",
        unsubscribe: "",
      },
      color: {
        button: "",
        text: "",
      }
    };

    if (!serverConfig || !serverConfig.config ||
      !serverConfig.config.staticPrompts || !serverConfig.config.staticPrompts.customlink ||
      !serverConfig.config.staticPrompts.customlink.enabled) {
      return initialState;
    }

    const customlink = serverConfig.config.staticPrompts.customlink;

    return {
      enabled: customlink.enabled,
      style: customlink.style,
      size: customlink.size,
      unsubscribeEnabled: customlink.unsubscribeEnabled,
      text: customlink.text ? {
        subscribe: customlink.text.subscribe,
        unsubscribe: customlink.text.unsubscribe,
        explanation: customlink.text.explanation,
      } : initialState.text,
      color: customlink.color ? {
        button: customlink.color.button,
        text: customlink.color.text,
      } : initialState.color,
    };
  }

  /**
   * Used for Custom Code Integration Type
   * @param  {AppUserConfigPromptOptions|undefined} promptOptions
   * @param  {ServerAppPromptConfig} defaultsFromServer
   * @param  {AppUserConfig} wholeUserConfig
   * @param  {boolean=false} isUsingSubscriptionWorkaround
   * @returns AppUserConfigPromptOptions
   */
  public static injectDefaultsIntoPromptOptions(
    promptOptions: AppUserConfigPromptOptions | undefined,
    defaultsFromServer: ServerAppPromptConfig,
    wholeUserConfig: AppUserConfig,
    isUsingSubscriptionWorkaround: boolean = false,
  ): AppUserConfigPromptOptions | undefined {

    let customlinkUser: AppUserConfigCustomLinkOptions = { enabled: false };
    if (promptOptions && promptOptions.customlink) {
      customlinkUser = promptOptions.customlink;
    }
    const customlinkDefaults = defaultsFromServer.customlink;
    const promptOptionsConfig: AppUserConfigPromptOptions = {
      ...promptOptions,
      customlink: {
        enabled: Utils.getValueOrDefault(customlinkUser.enabled, customlinkDefaults.enabled),
        style: Utils.getValueOrDefault(customlinkUser.style, customlinkDefaults.style),
        size: Utils.getValueOrDefault(customlinkUser.size, customlinkDefaults.size),
        unsubscribeEnabled: Utils.getValueOrDefault(customlinkUser.unsubscribeEnabled,
          customlinkDefaults.unsubscribeEnabled),
        text: {
          subscribe: Utils.getValueOrDefault(customlinkUser.text ? customlinkUser.text.subscribe : undefined,
            customlinkDefaults.text.subscribe),
          unsubscribe: Utils.getValueOrDefault(customlinkUser.text ? customlinkUser.text.unsubscribe: undefined,
            customlinkDefaults.text.unsubscribe),
          explanation: Utils.getValueOrDefault(customlinkUser.text ? customlinkUser.text.explanation : undefined,
            customlinkDefaults.text.explanation),
        },
        color: {
          button: Utils.getValueOrDefault(customlinkUser.color ? customlinkUser.color.button : undefined,
            customlinkDefaults.color.button),
          text: Utils.getValueOrDefault(customlinkUser.color ? customlinkUser.color.text : undefined,
            customlinkDefaults.color.text),
        },
      }
    };

    if (promptOptionsConfig.slidedown) {
      promptOptionsConfig.slidedown.prompts = promptOptionsConfig.slidedown?.prompts?.map(promptOption => {
        promptOption.type = Utils.getValueOrDefault(promptOption.type, DelayedPromptType.Push);

        if (promptOption.type === DelayedPromptType.Category) {
          promptOption.text = {
            ...promptOption.text,
            positiveUpdateButton: Utils.getValueOrDefault(promptOption.text?.positiveUpdateButton,
              SERVER_CONFIG_DEFAULTS_SLIDEDOWN.categoryDefaults.positiveUpdateButton),
            negativeUpdateButton: Utils.getValueOrDefault(promptOption.text?.negativeUpdateButton,
              SERVER_CONFIG_DEFAULTS_SLIDEDOWN.categoryDefaults.negativeUpdateButton),
            updateMessage: Utils.getValueOrDefault(promptOption.text?.updateMessage,
              SERVER_CONFIG_DEFAULTS_SLIDEDOWN.categoryDefaults.updateMessage),
          };
        }

        promptOption.text = {
          ...promptOption.text,
          actionMessage: Utils.getValueOrDefault(promptOption.text?.actionMessage,
            SERVER_CONFIG_DEFAULTS_SLIDEDOWN.actionMessage),
          acceptButton: Utils.getValueOrDefault(promptOption.text?.acceptButton,
            SERVER_CONFIG_DEFAULTS_SLIDEDOWN.acceptButton),
          cancelButton: Utils.getValueOrDefault(promptOption.text?.cancelButton,
            SERVER_CONFIG_DEFAULTS_SLIDEDOWN.cancelButton),
          confirmMessage: Utils.getValueOrDefault(promptOption.text?.confirmMessage,
            SERVER_CONFIG_DEFAULTS_SLIDEDOWN.confirmMessage)
        };

        // default autoPrompt to true iff slidedown config exists but omitted the autoPrompt setting
        promptOption.autoPrompt = Utils.getValueOrDefault(promptOption.autoPrompt, true);

        promptOption.delay = {
          pageViews: Utils.getValueOrDefault(promptOption.delay?.pageViews,
            SERVER_CONFIG_DEFAULTS_PROMPT_DELAYS.pageViews),
          timeDelay: Utils.getValueOrDefault(promptOption.delay?.timeDelay,
            SERVER_CONFIG_DEFAULTS_PROMPT_DELAYS.timeDelay)
        };

        if (promptOption.categories) {
          const { categories } = promptOption;
          promptOption.categories = TagUtils.limitCategoriesToMaxCount(categories, MAX_CATEGORIES);
        }

        return promptOption;
      });

    } else {
      promptOptionsConfig.slidedown = { prompts: [] };
      promptOptionsConfig.slidedown.prompts = [ CONFIG_DEFAULTS_SLIDEDOWN_OPTIONS ];
    }

    if (promptOptionsConfig.native) {
      promptOptionsConfig.native.enabled = !!promptOptionsConfig.native.enabled;
      promptOptionsConfig.native.autoPrompt = promptOptionsConfig.native.hasOwnProperty("autoPrompt") ?
        !!promptOptionsConfig.native.enabled && !!promptOptionsConfig.native.autoPrompt :
        !!promptOptionsConfig.native.enabled;
      promptOptionsConfig.native.pageViews = Utils.getValueOrDefault(promptOptionsConfig.native.pageViews,
        SERVER_CONFIG_DEFAULTS_PROMPT_DELAYS.pageViews);
      promptOptionsConfig.native.timeDelay = Utils.getValueOrDefault(promptOptionsConfig.native.timeDelay,
        SERVER_CONFIG_DEFAULTS_PROMPT_DELAYS.timeDelay);
    } else {
      promptOptionsConfig.native = {
        enabled: false,
        autoPrompt: false,
        pageViews: SERVER_CONFIG_DEFAULTS_PROMPT_DELAYS.pageViews,
        timeDelay: SERVER_CONFIG_DEFAULTS_PROMPT_DELAYS.timeDelay
      };
    }

    /**
     * If autoRegister is true, show native prompt for https and slidedown for http ignoring any other related
     * prompt options.
     */
    if (wholeUserConfig.autoRegister === true) {
      if (isUsingSubscriptionWorkaround) {
        // disable native prompt
        promptOptionsConfig.native.enabled = false;
        promptOptionsConfig.native.autoPrompt = false;

        // enable slidedown & make it autoPrompt
        const text = {
          actionMessage : SERVER_CONFIG_DEFAULTS_SLIDEDOWN.actionMessage,
          acceptButton  : SERVER_CONFIG_DEFAULTS_SLIDEDOWN.acceptButton,
          cancelButton  : SERVER_CONFIG_DEFAULTS_SLIDEDOWN.cancelButton,
        };
        promptOptionsConfig.slidedown.prompts = [{ type: DelayedPromptType.Push, autoPrompt: true, text }];
      } else {
        //enable native prompt & make it autoPrompt
        promptOptionsConfig.native.enabled = true;
        promptOptionsConfig.native.autoPrompt = true;

        //leave slidedown settings without change
      }
    }

    // sets top level `autoPrompt` to trigger autoprompt codepath in initialization / prompting flow
    promptOptionsConfig.autoPrompt = promptOptionsConfig.native.autoPrompt ||
      PromptsHelper.isSlidedownAutoPromptConfigured(promptOptionsConfig.slidedown.prompts);

    return promptOptionsConfig;
  }

  /**
   * Used only with Dashboard Configuration
   * @param  {ServerAppConfig} serverConfig
   * @returns AppUserConfigPromptOptions
   */
  private static getPromptOptionsForDashboardConfiguration(serverConfig: ServerAppConfig): AppUserConfigPromptOptions {
    const staticPrompts = serverConfig.config.staticPrompts;
    const native = staticPrompts.native ? {
      enabled: staticPrompts.native.enabled,
      autoPrompt: staticPrompts.native.enabled && staticPrompts.native.autoPrompt !== false,
      pageViews: Utils.getValueOrDefault(staticPrompts.native.pageViews,
          SERVER_CONFIG_DEFAULTS_PROMPT_DELAYS.pageViews),
      timeDelay: Utils.getValueOrDefault(staticPrompts.native.timeDelay,
          SERVER_CONFIG_DEFAULTS_PROMPT_DELAYS.timeDelay)
    } : {
      enabled: false,
      autoPrompt: false,
      pageViews: SERVER_CONFIG_DEFAULTS_PROMPT_DELAYS.pageViews,
      timeDelay: SERVER_CONFIG_DEFAULTS_PROMPT_DELAYS.timeDelay
    };

    const { prompts } = staticPrompts.slidedown;

    return {
      autoPrompt: native.autoPrompt || PromptsHelper.isSlidedownAutoPromptConfigured(prompts),
      native,
      slidedown: {
        prompts
      },
      fullscreen: {
        enabled: staticPrompts.fullscreen.enabled,
        actionMessage: staticPrompts.fullscreen.actionMessage,
        acceptButton: staticPrompts.fullscreen.acceptButton,
        cancelButton: staticPrompts.fullscreen.cancelButton,
        title: staticPrompts.fullscreen.title,
        message: staticPrompts.fullscreen.message,
        caption: staticPrompts.fullscreen.caption,
        autoAcceptTitle: staticPrompts.fullscreen.autoAcceptTitle,
      },
      customlink: this.getCustomLinkConfig(serverConfig),
    };
  }

  public static getUserConfigForConfigIntegrationKind(
    configIntegrationKind: ConfigIntegrationKind,
    userConfig: AppUserConfig,
    serverConfig: ServerAppConfig,
    isUsingSubscriptionWorkaround: boolean = false,
  ): AppUserConfig {
    const integrationCapabilities = this.getIntegrationCapabilities(configIntegrationKind);
    switch (integrationCapabilities.configuration) {
      case IntegrationConfigurationKind.Dashboard:
       /*
         Ignores code-based initialization configuration and uses dashboard configuration only.
        */
        return {
          appId: serverConfig.app_id,
          autoRegister: false,
          autoResubscribe: serverConfig.config.autoResubscribe,
          path: serverConfig.config.serviceWorker.path,
          serviceWorkerPath: serverConfig.config.serviceWorker.workerName,
          serviceWorkerParam: { scope: serverConfig.config.serviceWorker.registrationScope },
          subdomainName: serverConfig.config.siteInfo.proxyOrigin,
          promptOptions: this.getPromptOptionsForDashboardConfiguration(serverConfig),
          welcomeNotification: {
            disable: !serverConfig.config.welcomeNotification.enable,
            title: serverConfig.config.welcomeNotification.title,
            message: serverConfig.config.welcomeNotification.message,
            url: serverConfig.config.welcomeNotification.url
          },
          notifyButton: {
            enable: serverConfig.config.staticPrompts.bell.enabled,
            displayPredicate: serverConfig.config.staticPrompts.bell.hideWhenSubscribed ?
              () => {
                return OneSignal.isPushNotificationsEnabled()
                  .then((isPushEnabled: boolean) => {
                      /* The user is subscribed, so we want to return "false" to hide the notify button */
                      return !isPushEnabled;
                  });
              } :
              null,
            size: serverConfig.config.staticPrompts.bell.size,
            position: serverConfig.config.staticPrompts.bell.location,
            showCredit: false,
            offset: {
              bottom: `${serverConfig.config.staticPrompts.bell.offset.bottom}px`,
              left: `${serverConfig.config.staticPrompts.bell.offset.left}px`,
              right: `${serverConfig.config.staticPrompts.bell.offset.right}px`
            },
            colors: {
              'circle.background': serverConfig.config.staticPrompts.bell.color.main,
              'circle.foreground': serverConfig.config.staticPrompts.bell.color.accent,
              'badge.background': 'black',
              'badge.foreground': 'white',
              'badge.bordercolor': 'black',
              'pulse.color': serverConfig.config.staticPrompts.bell.color.accent,
              'dialog.button.background.hovering': serverConfig.config.staticPrompts.bell.color.main,
              'dialog.button.background.active': serverConfig.config.staticPrompts.bell.color.main,
              'dialog.button.background': serverConfig.config.staticPrompts.bell.color.main,
              'dialog.button.foreground': 'white',
            },
            text: {
              'tip.state.unsubscribed': serverConfig.config.staticPrompts.bell.tooltip.unsubscribed,
              'tip.state.subscribed': serverConfig.config.staticPrompts.bell.tooltip.subscribed,
              'tip.state.blocked': serverConfig.config.staticPrompts.bell.tooltip.blocked,
              'message.prenotify': serverConfig.config.staticPrompts.bell.tooltip.unsubscribed,
              'message.action.subscribing': serverConfig.config.staticPrompts.bell.message.subscribing,
              'message.action.subscribed': serverConfig.config.staticPrompts.bell.message.subscribing,
              'message.action.resubscribed': serverConfig.config.staticPrompts.bell.message.subscribing,
              'message.action.unsubscribed': serverConfig.config.staticPrompts.bell.message.unsubscribing,
              'dialog.main.title': serverConfig.config.staticPrompts.bell.dialog.main.title,
              'dialog.main.button.subscribe': serverConfig.config.staticPrompts.bell.dialog.main.subscribeButton,
              'dialog.main.button.unsubscribe': serverConfig.config.staticPrompts.bell.dialog.main.unsubscribeButton,
              'dialog.blocked.title': serverConfig.config.staticPrompts.bell.dialog.blocked.title,
              'dialog.blocked.message': serverConfig.config.staticPrompts.bell.dialog.blocked.message,
            },
          },
          persistNotification: serverConfig.config.notificationBehavior ?
            serverConfig.config.notificationBehavior.display.persist : undefined,
          webhooks: {
            cors: serverConfig.config.webhooks.corsEnable,
            'notification.displayed': serverConfig.config.webhooks.notificationDisplayedHook,
            'notification.clicked': serverConfig.config.webhooks.notificationClickedHook,
            'notification.dismissed': serverConfig.config.webhooks.notificationDismissedHook,
          },
          notificationClickHandlerMatch: serverConfig.config.notificationBehavior ?
            serverConfig.config.notificationBehavior.click.match : undefined,
          notificationClickHandlerAction: serverConfig.config.notificationBehavior ?
            serverConfig.config.notificationBehavior.click.action : undefined,
          allowLocalhostAsSecureOrigin: serverConfig.config.setupBehavior ?
            serverConfig.config.setupBehavior.allowLocalhostAsSecureOrigin : undefined,
          requiresUserPrivacyConsent: userConfig.requiresUserPrivacyConsent,
          outcomes: {
            direct: serverConfig.config.outcomes.direct,
            indirect: {
              enabled: serverConfig.config.outcomes.indirect.enabled,
              influencedTimePeriodMin:
                serverConfig.config.outcomes.indirect.notification_attribution.minutes_since_displayed,
              influencedNotificationsLimit: serverConfig.config.outcomes.indirect.notification_attribution.limit,
            },
            unattributed: serverConfig.config.outcomes.unattributed,
          }
        };
      case IntegrationConfigurationKind.JavaScript:
        /*
          Ignores dashboard configuration and uses code-based configuration only.
          Except injecting some default values for prompts.
        */
        const isTopLevelServiceWorkerParamDefined = typeof OneSignal !== 'undefined' &&
          !!OneSignal.SERVICE_WORKER_PARAM;
        const isTopLevelServiceWorkerPathDefined = typeof OneSignal !== 'undefined' &&
          !!OneSignal.SERVICE_WORKER_PATH;

        const fallbackServiceWorkerParam = isTopLevelServiceWorkerParamDefined ?
          OneSignal.SERVICE_WORKER_PARAM : { scope: '/' };
        const fallbackServiceWorkerPath = isTopLevelServiceWorkerPathDefined ?
          OneSignal.SERVICE_WORKER_PATH : 'OneSignalSDKWorker.js';

        const config = {
          ...userConfig,
          promptOptions: this.injectDefaultsIntoPromptOptions(
            userConfig.promptOptions,
            serverConfig.config.staticPrompts,
            userConfig,
            isUsingSubscriptionWorkaround
          ),
          ...{
            serviceWorkerParam: !!userConfig.serviceWorkerParam ?
              userConfig.serviceWorkerParam : fallbackServiceWorkerParam,
            serviceWorkerPath: !!userConfig.serviceWorkerPath ?
              userConfig.serviceWorkerPath : fallbackServiceWorkerPath,
            path: !!userConfig.path ? userConfig.path : '/'
          },
          outcomes: {
            direct: serverConfig.config.outcomes.direct,
            indirect: {
              enabled: serverConfig.config.outcomes.indirect.enabled,
              influencedTimePeriodMin:
                serverConfig.config.outcomes.indirect.notification_attribution.minutes_since_displayed,
              influencedNotificationsLimit: serverConfig.config.outcomes.indirect.notification_attribution.limit,
            },
            unattributed: serverConfig.config.outcomes.unattributed,
          }
        };

        if (userConfig.hasOwnProperty("autoResubscribe")) {
          config.autoResubscribe = !!userConfig.autoResubscribe;
        } else if (userConfig.hasOwnProperty("autoRegister")) {
          config.autoResubscribe = !!userConfig.autoRegister;
        } else {
          config.autoResubscribe = !!serverConfig.config.autoResubscribe;
        }

        return config;
    }
  }

  /**
   * Describes how to merge a dashboard-set subdomain with a/lack of user-supplied subdomain.
   */
  public static getSubdomainForConfigIntegrationKind(
    configIntegrationKind: ConfigIntegrationKind,
    userConfig: AppUserConfig,
    serverConfig: ServerAppConfig
  ): string | undefined {
    const integrationCapabilities = this.getIntegrationCapabilities(configIntegrationKind);
    const userValue: string | undefined = userConfig.subdomainName;
    let serverValue: string | undefined = '';

    switch (integrationCapabilities.configuration) {
      case IntegrationConfigurationKind.Dashboard:
        serverValue = serverConfig.config.siteInfo.proxyOriginEnabled ?
          serverConfig.config.siteInfo.proxyOrigin :
          undefined;
        break;
      case IntegrationConfigurationKind.JavaScript:
        serverValue = serverConfig.config.subdomain;
        break;
    }

    if (serverValue && !this.shouldUseServerConfigSubdomain(userValue, integrationCapabilities)) {
      return undefined;
    } else {
      return serverValue;
    }
  }

  public static shouldUseServerConfigSubdomain(
    userProvidedSubdomain: string | undefined,
    capabilities: IntegrationCapabilities
  ): boolean {
    switch (capabilities.configuration) {
      case IntegrationConfigurationKind.Dashboard:
        /*
          Dashboard config using the new web config editor always takes precedence.
         */
        return true;
      case IntegrationConfigurationKind.JavaScript:
        /*
         * An HTTPS site may be using either a native push integration or a fallback
         * subdomain integration. Our SDK decides the integration based on whether
         * init option subdomainName appears and the site's protocol.
         *
         * To avoid having developers write JavaScript to customize the SDK,
         * configuration properties like subdomainName are downloaded on page start.
         *
         * New developers setting up web push can omit subdomainName, but existing
         * developers already having written code to configure OneSignal aren't
         * removing their code.
         *
         * When an HTTPS site is configured with a subdomain on the server-side, we do
         * not apply it even though we've downloaded this configuration unless the
         * user also declares it manually in their initialization code.
         */
        switch (location.protocol) {
          case 'https:':
            return !!userProvidedSubdomain;
          case 'http:':
            return true;
          default:
            return false;
        }
    }
  }
}
