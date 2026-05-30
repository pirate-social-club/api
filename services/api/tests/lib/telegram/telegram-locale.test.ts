import { describe, expect, test } from "bun:test"

import {
  resolveRuntimeUiLocale,
  resolveTelegramStartLocale,
} from "../../../src/lib/telegram/telegram-locale"

describe("telegram locale helpers", () => {
  test("normalizes supported Telegram language tags", () => {
    expect(resolveRuntimeUiLocale("en-US")).toBe("en")
    expect(resolveRuntimeUiLocale("ar")).toBe("ar")
    expect(resolveRuntimeUiLocale("zh-CN")).toBe("zh")
    expect(resolveRuntimeUiLocale("ka-GE")).toBe("ka")
  })

  test("ignores unsupported and pseudo locales at runtime", () => {
    expect(resolveRuntimeUiLocale("fr")).toBeNull()
    expect(resolveRuntimeUiLocale("pseudo")).toBeNull()
    expect(resolveRuntimeUiLocale(null)).toBeNull()
  })

  test("prefers Telegram language, then profile locale, then English", () => {
    expect(resolveTelegramStartLocale({
      telegramLanguageCode: "ar",
      profilePreferredLocale: "zh",
    })).toBe("ar")
    expect(resolveTelegramStartLocale({
      telegramLanguageCode: "ka",
      profilePreferredLocale: "zh-CN",
    })).toBe("ka")
    expect(resolveTelegramStartLocale({
      telegramLanguageCode: "fr",
      profilePreferredLocale: null,
    })).toBe("en")
  })
})
