import { describe, expect, test } from "bun:test"
import {
  runSettlePirateCheckoutSpendIntent,
  type SpendIntentRuntimeDeps,
} from "../src/lib/communities/commerce/funding-source/settlement-runtime"

describe("spend intent settlement runtime entry point", () => {
  // Review gate #1: the control-plane client is created AND consumed strictly inside the
  // withRequestControlPlaneClients scope, never before it opens or after it closes.
  test("obtains and uses the control-plane client inside request scope", async () => {
    const order: string[] = []
    const cpClient = { marker: "control-plane-client" }

    const deps: SpendIntentRuntimeDeps = {
      withRequestControlPlaneClients: async (operation) => {
        order.push("scope:enter")
        try {
          return await operation()
        } finally {
          order.push("scope:exit")
        }
      },
      getControlPlaneClient: (() => {
        order.push("getControlPlaneClient")
        return cpClient as never
      }) as SpendIntentRuntimeDeps["getControlPlaneClient"],
      settlePirateCheckoutSpendIntent: (async (callInput) => {
        order.push("settle")
        // The client handed to settlement must be the one created inside the scope.
        expect(callInput.controlPlaneClient).toBe(cpClient as never)
        expect(callInput.spendIntentId).toBe("spi_rt")
        expect(callInput.fundingTxRef).toBe("0xBASErt")
        // The authorization hook is forwarded unchanged to the orchestrator.
        expect(callInput.authorize).toBe(authorizeHook)
        return { status: "funding_confirmed" } as never
      }) as SpendIntentRuntimeDeps["settlePirateCheckoutSpendIntent"],
    }

    const authorizeHook = () => {}
    const result = await runSettlePirateCheckoutSpendIntent(
      {
        env: {} as never,
        communityRepository: {} as never,
        spendIntentId: "spi_rt",
        fundingTxRef: "0xBASErt",
        now: "2026-04-21T00:05:00.000Z",
        authorize: authorizeHook,
      },
      deps,
    )

    // getControlPlaneClient and settle both happen strictly between enter and exit, in order.
    expect(order).toEqual(["scope:enter", "getControlPlaneClient", "settle", "scope:exit"])
    expect(result.status).toBe("funding_confirmed")
  })

  test("propagates settlement errors out through the scope (which still closes)", async () => {
    const order: string[] = []
    const deps: SpendIntentRuntimeDeps = {
      withRequestControlPlaneClients: async (operation) => {
        try {
          return await operation()
        } finally {
          order.push("scope:exit")
        }
      },
      getControlPlaneClient: (() => ({}) as never) as SpendIntentRuntimeDeps["getControlPlaneClient"],
      settlePirateCheckoutSpendIntent: (async () => {
        throw new Error("spend intent is not resolved")
      }) as SpendIntentRuntimeDeps["settlePirateCheckoutSpendIntent"],
    }

    await expect(
      runSettlePirateCheckoutSpendIntent(
        {
          env: {} as never,
          communityRepository: {} as never,
          spendIntentId: "spi_err",
          fundingTxRef: "0xBASEerr",
          now: "2026-04-21T00:05:00.000Z",
        },
        deps,
      ),
    ).rejects.toThrow(/not resolved/i)
    // The scope still unwinds (request-scoped CP clients get closed) even on error.
    expect(order).toEqual(["scope:exit"])
  })
})
