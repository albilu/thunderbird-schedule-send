"""Compare extension controls with the colors resolved by real Thunderbird CSS."""
import time

API = "window.wrappedJSObject.messenger"
POPUP = "popup/popup.html"
MANAGE = "message/message.html?integration"


def native_palette(client, window_id):
    return client.script("""
      const win = testExtension.windowManager.get(arguments[0]).window;
      const probe = win.document.createElementNS('http://www.w3.org/1999/xhtml', 'span');
      probe.style.visibility = 'hidden';
      win.document.documentElement.append(probe);
      const color = value => { probe.style.color = value; return win.getComputedStyle(probe).color; };
      try {
        return {
          background: color('var(--panel-background-color, var(--arrowpanel-background, var(--color-surface-subtle, Canvas)))'),
          text: color('var(--panel-text-color, var(--arrowpanel-color, var(--color-text-base, CanvasText)))'),
          border: color('var(--panel-border-color, var(--arrowpanel-border-color, var(--color-surface-border-intense, ButtonBorder)))'),
          field: color('var(--toolbar-field-background-color, Field)'),
          fieldText: color('var(--toolbar-field-text-color, var(--toolbar-field-color, FieldText))'),
          button: color('var(--button-background-color, ButtonFace)'),
          buttonText: color('var(--button-text-color, ButtonText)'),
          accent: color('var(--button-primary-background-color, AccentColor)'),
          accentText: color('var(--button-primary-text-color, AccentColorText)'),
          accentHover: color('var(--button-primary-hover-background-color, AccentColor)'),
          scheme: color('light-dark(black, white)') === 'rgb(255, 255, 255)' ? 'dark' : 'light'
        };
      } finally { probe.remove(); }
    """, window_id)


def assert_palette(client, path, expected):
    return client.page(path, """
      const expected = arguments[0], deadline = Date.now() + 5000;
      return new Promise((resolve, reject) => {
        const timer = setInterval(() => {
          const root = getComputedStyle(document.documentElement);
          const primary = document.querySelector('button.primary');
          const input = document.querySelector('input:not([type=checkbox])');
          input?.blur();
          const dialog = document.querySelector('dialog[open]');
          const button = [...document.querySelectorAll('dialog[open] button[value=cancel], .presets button:not(.selected)')]
            .find(node => !node.matches(':hover'));
          const actual = {
            background: root.backgroundColor, text: root.color, scheme: root.colorScheme,
            border: root.getPropertyValue('--border').trim(),
            accent: root.getPropertyValue('--accent').trim(),
            accentText: primary && getComputedStyle(primary).color,
            primary: primary && getComputedStyle(primary).backgroundColor,
            field: input && getComputedStyle(input).backgroundColor,
            fieldText: input && getComputedStyle(input).color,
            button: button && getComputedStyle(button).backgroundColor,
            buttonText: button && getComputedStyle(button).color,
            dialog: dialog && getComputedStyle(dialog).backgroundColor
          };
          const target = {...expected,
            primary: primary?.matches(':enabled:hover') ? expected.accentHover : expected.accent};
          const keys = ['background', 'text', 'scheme', 'border', 'accent', 'accentText', 'primary'];
          if (input) keys.push('field', 'fieldText');
          if (button) keys.push('button', 'buttonText');
          if (dialog) { target.dialog = expected.background; keys.push('dialog'); }
          if (keys.every(key => actual[key] === target[key])) { clearInterval(timer); resolve(actual); }
          else if (Date.now() > deadline) {
            clearInterval(timer); reject(new Error(JSON.stringify({expected: target, actual})));
          }
        }, 30);
      });
    """, expected)


def theme_tests(client, screenshot):
    themes = client.async_script("""
      const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
      return (await AddonManager.getAddonsByTypes(['theme'])).map(t => ({id: t.id, active: t.isActive}));
    """)
    original = next(theme['id'] for theme in themes if theme['active'])
    main_id = client.page(MANAGE, f"return (await {API}.windows.getCurrent()).id;")
    compose = client.background(f"return {API}.compose.beginNew();")
    compose_id = compose['windowId']
    windows = [(MANAGE, main_id), (POPUP, compose_id)]
    accent_pref = client.script("""
      const key = 'mail.appearance.accentColor';
      return {exists: Services.prefs.getPrefType(key) !== 0, user: Services.prefs.prefHasUserValue(key),
        value: Services.prefs.getStringPref(key, '')};
    """)
    try:
        client.background(f"return {API}.composeAction.openPopup({{windowId: arguments[0]}});", compose_id)
        client.wait(f"return [...testExtension.views].some(v => v.uri?.spec === testExtension.baseURI.resolve('{POPUP}'));")
        client.page(MANAGE, "document.getElementById('confirmation').showModal();")
        backgrounds = []
        for scheme in ['light', 'dark']:
            theme = next(t['id'] for t in themes if f'compact-{scheme}@' in t['id'])
            client.async_script("""
              const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
              await (await AddonManager.getAddonByID(arguments[0])).enable();
            """, theme)
            time.sleep(.4)
            for path, window_id in windows:
                native = native_palette(client, window_id)
                assert native['scheme'] == scheme, native
                assert_palette(client, path, native)
            backgrounds.append(native['background'])
            screenshot(client, f'theme-{scheme}.png')
        assert backgrounds[0] != backgrounds[1], backgrounds

        # Different themes in two windows must not recolor one another's popup.
        warm = {'colors': {'frame': '#574225', 'tab_background_text': '#ffffff',
            'popup': '#f5e8cd', 'popup_text': '#382910', 'popup_border': '#876a30',
            'toolbar_field': '#fff8e9', 'toolbar_field_text': '#482c12',
            'sidebar_highlight': '#166b55', 'sidebar_highlight_text': '#ffffff'},
            'properties': {'color_scheme': 'light'}}
        cool = {'colors': {'frame': '#172e3f', 'tab_background_text': '#e4f7ff',
            'popup': '#173344', 'popup_text': '#e2f4fc', 'popup_border': '#5787a3',
            'toolbar_field': '#29485c', 'toolbar_field_text': '#f1fbff',
            'toolbar_field_focus': '#365b70', 'toolbar_field_text_focus': '#fff3d1',
            'toolbar_field_border_focus': '#facb73',
            'sidebar_highlight': '#f4b6e8', 'sidebar_highlight_text': '#3a1531'},
            'properties': {'color_scheme': 'dark'}}
        for window_id, details in [(main_id, warm), (compose_id, cool)]:
            client.background(f"return {API}.theme.update(arguments[0], arguments[1]);", window_id, details)
        time.sleep(.4)
        for (path, window_id), background in zip(windows, ['rgb(245, 232, 205)', 'rgb(23, 51, 68)']):
            native = native_palette(client, window_id)
            assert native['background'] == background, native
            assert_palette(client, path, native)
        screenshot(client, 'theme-custom.png')
        focused = client.page(POPUP, """
          const input = document.querySelector('input:not([type=checkbox])');
          input.focus();
          const style = getComputedStyle(input);
          return [style.backgroundColor, style.color, style.borderTopColor];
        """)
        assert focused == ['rgb(54, 91, 112)', 'rgb(255, 243, 209)', 'rgb(250, 203, 115)'], focused

        for _, window_id in windows:
            client.background(f"return {API}.theme.reset(arguments[0]);", window_id)
        time.sleep(.4)
        for path, window_id in windows:
            native = native_palette(client, window_id)
            assert native['background'] not in ['rgb(245, 232, 205)', 'rgb(23, 51, 68)'], native
            assert_palette(client, path, native)

        # Newer Thunderbird can change its accent without changing its theme.
        if accent_pref['exists']:
            accents = []
            for accent in ['purple', 'teal']:
                client.script("Services.prefs.setStringPref('mail.appearance.accentColor', arguments[0]);", accent)
                time.sleep(.2)
                for path, window_id in windows:
                    native = native_palette(client, window_id)
                    assert_palette(client, path, native)
                accents.append(native['accent'])
            assert accents[0] != accents[1], accents
            screenshot(client, 'theme-accent.png')
        print('PASS: live light/dark colors, custom window themes, reset, native fields/buttons/dialogs and available accent preferences', flush=True)
    finally:
        for _, window_id in windows:
            client.background(f"return {API}.theme.reset(arguments[0]);", window_id)
        if accent_pref['user']:
            client.script("Services.prefs.setStringPref('mail.appearance.accentColor', arguments[0]);", accent_pref['value'])
        else:
            client.script("Services.prefs.clearUserPref('mail.appearance.accentColor');")
        client.async_script("""
          const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
          await (await AddonManager.getAddonByID(arguments[0])).enable();
        """, original)
        client.page(MANAGE, "document.getElementById('confirmation').close();")
        client.script("""
          const win = testExtension.windowManager.get(arguments[0]).window;
          win.gContentChanged = false;
          win.gMsgCompose.bodyModified = false;
          win.close();
        """, compose_id)
