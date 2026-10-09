import { Chain, address, same } from "./chain.js";
import {
  ACTIONS,
  Action,
  Operation,
  ToolError,
  requireFact,
  epoch,
  integer,
  economics,
  signed64,
} from "./model.js";
import { CLAIM, ROUTE } from "./native.js";
export const EXEC = "/cosmwasm.wasm.v1.MsgExecuteContract";
const execute = (sender: string, contract: string, msg: any) => ({
  typeUrl: EXEC,
  value: { sender, contract, msg, funds: [] },
});
export async function prepare(
  c: Chain,
  action: Action,
  sender: string,
  input: any,
): Promise<Operation> {
  requireFact(ACTIONS.includes(action), "INVALID_ACTION", "Unknown operation");
  const fields: Record<Action, string[]> = {
    "create-offer": ["epoch", "price", "budget"],
    route: ["deal"],
    "remove-route": ["deal"],
    fund: ["deal"],
    lock: ["deal"],
    claim: ["deal", "seed"],
    settle: ["deal"],
    withdraw: ["deal", "role"],
    release: ["deal"],
    refund: ["deal", "emergency"],
    cancel: ["deal"],
    "forward-excess": ["deal"],
  };
  requireFact(
    input &&
      typeof input === "object" &&
      !Array.isArray(input) &&
      Object.keys(input).every((k) => fields[action].includes(k)),
    "INVALID_OPERATION_INPUT",
    "Unexpected fields for this action; amounts for funding come from verified immutable Deal terms",
  );
  requireFact(
    input.emergency === undefined || typeof input.emergency === "boolean",
    "INVALID_OPERATION_INPUT",
    "Emergency review must be explicit boolean",
  );
  address(sender);
  await c.verify();
  const height = await c.tip(),
    current = await c.currentEpoch(),
    d = c.deployment;
  let messages: any[], terms: any;
  if (action === "create-offer") {
    const E = epoch(input.epoch);
    requireFact(
      E > current && E <= current + 40,
      "EPOCH_WINDOW",
      "Offer must target a future epoch within 40",
    );
    await c.host(sender);
    terms = {
      host: sender,
      target_epoch: E,
      price_micro_usdt_per_gnk: input.price,
      buyer_budget_micro_usdt: input.budget,
      ...economics(input.budget, input.price),
    };
    messages = [
      execute(sender, d.factory, {
        create_offer: {
          target_epoch: E,
          price_micro_usdt_per_gnk: input.price,
          buyer_budget_micro_usdt: input.budget,
        },
      }),
    ];
  } else {
    const deal = address(input.deal),
      { config: k, state: s, payments } = await c.deal(deal),
      E = epoch(k.target_epoch);
    terms = {
      ...k,
      budgetEconomics: economics(
        k.buyer_budget_micro_usdt,
        k.price_micro_usdt_per_gnk,
      ),
      beforeState: s,
    };
    const window = current >= E && current < E + 5;
    // All routing failures propagate; absence is recognized only in a successful response.
    const routing = async () => {
      const routes = await c.routes(k.host);
      return {
        routes,
        exact: routes.some(
          (r) => Number(r.epoch) === E && r.recipient === deal,
        ),
      };
    };
    let msg: any;
    switch (action) {
      case "route":
      case "remove-route": {
        requireFact(
          sender === k.host,
          "HOST_AUTHORITY",
          "Routing requires participant owner/cold address",
        );
        await c.host(sender);
        requireFact(
          current < E && E <= current + 40,
          "EPOCH_WINDOW",
          "Routing changes require future epoch",
        );
        const { routes } = await routing();
        terms = { ...terms, previousRoutes: routes };
        // Native keeper updates only supplied epochs. Resending unrelated rows would reject past epochs.
        messages = [
          {
            typeUrl: ROUTE,
            value: {
              creator: sender,
              entries: [
                { epoch: String(E), recipient: action === "route" ? deal : "" },
              ],
            },
          },
        ];
        break;
      }
      case "claim": {
        requireFact(
          sender === k.host,
          "HOST_AUTHORITY",
          "v1 native claim signs directly as participant owner",
        );
        requireFact(
          current === E + 1,
          "EPOCH_WINDOW",
          "Native claim requires previous epoch",
        );
        requireFact(
          !(await c.summary(k.host, E)).claimed,
          "ALREADY_CLAIMED",
          "Claim already confirmed",
        );
        requireFact(
          (await routing()).exact,
          "ROUTING_MISMATCH",
          "Rewards must route to this Deal",
        );
        signed64(input.seed);
        messages = [
          {
            typeUrl: CLAIM,
            value: {
              creator: sender,
              seed: input.seed,
              epoch_index: String(E),
            },
          },
        ];
        break;
      }
      case "fund": {
        requireFact(
          s.status === "open" && !s.buyer && current < E,
          "STATE_GUARD",
          "Funding requires Open before target epoch",
        );
        requireFact(
          (await routing()).exact,
          "ROUTING_MISMATCH",
          "Exact routing required before funding",
        );
        const bal = await c.smart(d.token, { balance: { address: sender } });
        requireFact(
          integer(bal.balance, "token balance") >=
            integer(k.buyer_budget_micro_usdt, "budget"),
          "INSUFFICIENT_USDT",
          "Buyer USDT balance insufficient",
        );
        messages = [
          execute(sender, d.token, {
            send: {
              contract: deal,
              amount: k.buyer_budget_micro_usdt,
              msg: "eyJmdW5kIjp7fX0=",
            },
          }),
        ];
        break;
      }
      case "lock":
        requireFact(
          ["open", "funded"].includes(s.status) && window,
          "STATE_GUARD",
          "Lock requires Open/Funded in E..E+4",
        );
        requireFact(
          (await routing()).exact,
          "ROUTING_MISMATCH",
          "Exact routing required",
        );
        msg = { lock: {} };
        break;
      case "settle":
        requireFact(
          s.status === "locked" && s.recipient_locked,
          "STATE_GUARD",
          "Settlement requires Locked proof",
        );
        requireFact(
          (await c.summary(k.host, E)).claimed,
          "CLAIM_UNCONFIRMED",
          "Native claim is not confirmed",
        );
        msg = { settle_claim: {} };
        break;
      case "withdraw":
        requireFact(
          ["host", "fee", "buyer"].includes(input.role),
          "INVALID_ROLE",
          "Choose host, fee or buyer",
        );
        requireFact(
          integer(payments[input.role].pending_micro_usdt, "pending debt") > 0n,
          "NO_PAYMENT",
          "Role has no pending payment",
        );
        msg = { withdraw_usdt: { role: input.role } };
        break;
      case "release":
      case "forward-excess":
        requireFact(
          action === "forward-excess"
            ? s.status === "completed"
            : ["releasing", "completed", "refunded", "expired"].includes(
                s.status,
              ),
          "STATE_GUARD",
          "GNK release unavailable in current state",
        );
        requireFact(
          BigInt(await c.balance(deal)) > 0n,
          "NO_RELEASE",
          "No spendable GNK",
        );
        msg =
          action === "release"
            ? { release_unlocked_gnk: {} }
            : { forward_excess_gnk: {} };
        break;
      case "cancel":
        requireFact(
          s.status === "open" &&
            !s.buyer &&
            current < E + 5 &&
            (current >= E || sender === k.host),
          "STATE_GUARD",
          "Cancellation unavailable",
        );
        requireFact(
          !(await routing()).exact,
          "ROUTING_EXACT",
          "Remove future exact routing before cancellation",
        );
        msg = { cancel: {} };
        break;
      case "refund": {
        if (s.status === "funded") {
          requireFact(window, "EPOCH_WINDOW", "Routing refund requires E..E+4");
          requireFact(
            !(await routing()).exact,
            "ROUTING_EXACT",
            "Correct routing blocks refund",
          );
        } else {
          requireFact(
            s.status === "locked" && s.recipient_locked && current >= E + 2,
            "STATE_GUARD",
            "Claim expiry requires Locked from E+2",
          );
          try {
            requireFact(
              !(await c.summary(k.host, E)).claimed,
              "ALREADY_CLAIMED",
              "Claim confirmed; settle instead",
            );
          } catch (e) {
            if (e instanceof ToolError && e.code === "ALREADY_CLAIMED") throw e;
            requireFact(
              current >= E + 3 && input.emergency === true,
              "SUMMARY_UNAVAILABLE",
              "Summary unavailable: explicit emergency review required from E+3",
            );
            terms = {
              ...terms,
              emergencyReview: true,
              summaryError: e instanceof Error ? e.message : "unavailable",
            };
          }
        }
        msg = { refund: {} };
        break;
      }
      default:
        throw new ToolError("INVALID_ACTION", "Unsupported operation");
    }
    messages = messages! ?? [execute(sender, deal, msg)];
  }
  return {
    schema: "gonka24/forward-operation/1",
    deployment: d,
    sender,
    action,
    input,
    messages,
    terms,
    checkedAt: new Date().toISOString(),
    checkedHeight: height,
  };
}
export async function revalidate(c: Chain, op: Operation) {
  requireFact(
    op.test_fixture_only !== true,
    "TEST_FIXTURE",
    "Example/test packages cannot authorize live transactions",
  );
  requireFact(
    op.schema === "gonka24/forward-operation/1" &&
      same(op.deployment, c.deployment),
    "INVALID_OPERATION",
    "Operation deployment differs",
  );
  const fresh = await prepare(c, op.action, op.sender, op.input);
  requireFact(
    same(fresh.messages, op.messages),
    "OPERATION_CHANGED",
    "Operation messages changed",
  );
  const immutable = (terms: any) =>
    Object.fromEntries(
      Object.entries(terms).filter(
        ([key]) =>
          ![
            "beforeState",
            "previousRoutes",
            "summaryError",
            "emergencyReview",
          ].includes(key),
      ),
    );
  requireFact(
    same(immutable(fresh.terms), immutable(op.terms)),
    "OPERATION_TERMS_CHANGED",
    "Displayed immutable terms differ from current verified operation",
  );
  return fresh;
}
export async function status(c: Chain, a: string) {
  await c.verify();
  const deal = await c.deal(a),
    current = await c.currentEpoch(),
    E = deal.config.target_epoch;
  const actions: string[] = [];
  if (
    ["open", "funded"].includes(deal.state.status) &&
    current >= E &&
    current < E + 5
  )
    actions.push("Check routing and prioritize Lock");
  if (deal.state.status === "locked")
    actions.push("Check native claim before settlement or refund");
  for (const role of ["host", "fee", "buyer"])
    if (BigInt(deal.payments[role].pending_micro_usdt) > 0n)
      actions.push(`Withdraw USDT for ${role} in separate transaction`);
  const bank = await c.balance(a);
  if (
    BigInt(bank) > 0n &&
    ["releasing", "completed", "refunded", "expired"].includes(
      deal.state.status,
    )
  )
    actions.push("Release available GNK");
  let native: any;
  try {
    native = await c.smart(a, { native_status: {} });
  } catch (e) {
    native = {
      status: "UNAVAILABLE",
      error: e instanceof ToolError ? e.code : "QUERY_FAILED",
    };
  }
  return {
    ...deal,
    budgetEconomics: economics(
      deal.config.buyer_budget_micro_usdt,
      deal.config.price_micro_usdt_per_gnk,
    ),
    status: native?.status === "UNAVAILABLE" ? "INCOMPLETE" : "OBSERVED",
    currentEpoch: current,
    lockDeadlineExclusive: E + 5,
    claimEpoch: E + 1,
    claimExpiryEpoch: E + 2,
    emergencyRefundEpoch: E + 3,
    spendableNgonka: bank,
    native,
    nextActions: actions,
    note: "Completed does not prove USDT delivery or end of vesting",
  };
}
