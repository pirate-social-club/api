import { describe, expect, test } from "bun:test"

import { getTelegramCopy } from "../../../src/lib/telegram/telegram-copy"

describe("telegram copy catalog", () => {
  test("interpolates English community start copy", () => {
    const copy = getTelegramCopy("en")

    expect(copy.start.alreadyJoined({ community: "Americans only 2" }))
      .toBe("You've already joined \"Americans only 2\".")
    expect(copy.start.joined({ community: "Americans only 2" }))
      .toBe("You've joined \"Americans only 2\".")
    expect(copy.buttons.openCommunity).toBe("Open community")
  })

  test("provides localized start copy", () => {
    expect(getTelegramCopy("ar").buttons.verifyToJoin).toBe("تحقق للانضمام")
    expect(getTelegramCopy("zh").start.linkRequired({ community: "Americans only 2" }))
      .toContain("关联你的 Pirate 账号")
    expect(getTelegramCopy("ka").buttons.verifyToJoin).toBe("გაიარეთ ვერიფიკაცია")
    expect(getTelegramCopy("ka").start.linkRequired({ community: "🇬🇪" }))
      .toContain("დააკავშირეთ თქვენი Pirate ანგარიში")
  })
})
