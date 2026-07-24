import { describe, expect, it } from "vitest";
import { CLASSIC_THEME_ID, DEFAULT_THEME_PREFERENCE, findThemePairForTheme, resolveThemePreference } from "./theme";
import type { QualifiedContributionId, QualifiedThemeContribution, QualifiedThemePairContribution, ThemeColorScheme, ThemeTokens } from "./plugins/types";

const tokens = {
  "--pi-bg": "#000000",
  "--pi-surface": "#000000",
  "--pi-surface-hover": "#000000",
  "--pi-terminal-bg": "#000000",
  "--pi-terminal-text": "#000000",
  "--pi-border": "#000000",
  "--pi-border-muted": "#000000",
  "--pi-text": "#000000",
  "--pi-text-secondary": "#000000",
  "--pi-text-bright": "#000000",
  "--pi-muted": "#000000",
  "--pi-dim": "#000000",
  "--pi-accent": "#000000",
  "--pi-accent-border": "#000000",
  "--pi-selection-bg": "#000000",
  "--pi-success": "#000000",
  "--pi-success-border": "#000000",
  "--pi-success-bg": "#000000",
  "--pi-success-surface": "#000000",
  "--pi-success-ring": "#000000",
  "--pi-warning": "#000000",
  "--pi-warning-border": "#000000",
  "--pi-warning-surface": "#000000",
  "--pi-danger": "#000000",
  "--pi-purple": "#000000",
  "--pi-purple-border": "#000000",
  "--pi-purple-surface": "#000000",
  "--pi-overlay": "#000000",
  "--pi-shadow-soft": "#000000",
  "--pi-shadow": "#000000",
  "--pi-shadow-strong": "#000000",
  "--pi-bg-overlay-soft": "#000000",
  "--pi-bg-overlay": "#000000",
  "--pi-success-bg-overlay": "#000000",
  "--pi-terminal-selection": "#000000",
} satisfies ThemeTokens;

const themes = [
  theme("pi-webui-dark", "PI WEBUI Dark", "dark"),
  theme("pi-webui-light", "PI WEBUI Light", "light"),
  theme("classic", "PI WEBUI Classic", "dark"),
];

const themePairs: QualifiedThemePairContribution[] = [
  {
    id: "themes:pi-webui",
    pluginId: "themes",
    localId: "pi-webui",
    name: "PI WEBUI",
    light: "themes:pi-webui-light",
    dark: "themes:pi-webui-dark",
  },
];

describe("resolveThemePreference", () => {
  it("resolves the default auto preference to the dark member when the system is dark", () => {
    expect(resolveThemePreference({ themes, themePairs, preference: DEFAULT_THEME_PREFERENCE, prefersLight: false }).activeTheme?.id)
      .toBe("themes:pi-webui-dark");
  });

  it("resolves the default auto preference to the light member when the system is light", () => {
    expect(resolveThemePreference({ themes, themePairs, preference: DEFAULT_THEME_PREFERENCE, prefersLight: true }).activeTheme?.id)
      .toBe("themes:pi-webui-light");
  });

  it("keeps an unpaired theme selected when auto is enabled", () => {
    const resolution = resolveThemePreference({
      themes,
      themePairs,
      preference: { themeId: CLASSIC_THEME_ID, auto: true },
      prefersLight: true,
    });

    expect(resolution.selectedTheme?.id).toBe("themes:classic");
    expect(resolution.activeTheme?.id).toBe("themes:classic");
    expect(resolution.selectedThemePair).toBeUndefined();
  });

  it("falls back to Classic when the selected theme does not exist", () => {
    const resolution = resolveThemePreference({
      themes,
      themePairs,
      preference: { themeId: "plugin:missing", auto: false },
      prefersLight: true,
    });

    expect(resolution.selectedTheme?.id).toBe("themes:classic");
    expect(resolution.activeTheme?.id).toBe("themes:classic");
  });

  it("falls back to Classic without mutating a missing selected theme preference", () => {
    const preference = {
      themeId: "plugin:missing",
      auto: true,
    } satisfies { themeId: QualifiedContributionId; auto: boolean };
    const resolution = resolveThemePreference({
      themes,
      themePairs,
      preference,
      prefersLight: false,
    });

    expect(resolution.selectedTheme?.id).toBe("themes:classic");
    expect(resolution.activeTheme?.id).toBe("themes:classic");
    expect(preference).toEqual({ themeId: "plugin:missing", auto: true });
  });

  it("can look up a pair from either member theme", () => {
    expect(findThemePairForTheme(themePairs, "themes:pi-webui-light")?.id).toBe("themes:pi-webui");
    expect(findThemePairForTheme(themePairs, "themes:pi-webui-dark")?.id).toBe("themes:pi-webui");
  });
});

function theme(localId: string, name: string, colorScheme: ThemeColorScheme): QualifiedThemeContribution {
  return {
    id: `themes:${localId}`,
    pluginId: "themes",
    localId,
    name,
    colorScheme,
    tokens,
  };
}
