function queryKey(value) {
  return String(value ?? "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

function queryList(value) {
  return Array.isArray(value) ? value : [];
}

function itemId(item, index) {
  const value = String(item?.id ?? "").trim();
  return value || `item-${index + 1}`;
}

function publicEntry(entry) {
  return {
    query: entry.query,
    global: entry.global,
    itemIds: [...entry.itemIds],
  };
}

/**
 * Allocate a bounded set of provider queries without letting the first shopping
 * line consume the entire budget. The first pass gives every shopping line one
 * chance, shared queries cover every associated line, global queries follow,
 * and remaining per-line queries are selected round-robin.
 *
 * The function never claims full coverage when the budget truncates work. Its
 * omittedQueries and omittedItems fields are intended to flow directly into
 * provider coverage metadata.
 */
export function planRoundRobinQueries({
  globalQueries = [],
  shoppingItems = [],
  queryField = "catalogQueries",
  budget = 8,
} = {}) {
  if (!Number.isInteger(budget) || budget < 0) {
    throw new RangeError("Query budget must be a non-negative integer");
  }
  if (!Array.isArray(shoppingItems)) throw new TypeError("shoppingItems must be an array");
  if (typeof queryField !== "string" || !queryField) throw new TypeError("queryField must be a non-empty string");

  const entries = new Map();
  const itemQueues = [];
  const globalKeys = [];

  function register(rawQuery, { global = false, id = null } = {}) {
    const query = String(rawQuery ?? "").trim().replace(/\s+/g, " ");
    const key = queryKey(query);
    if (!key) return null;
    let entry = entries.get(key);
    if (!entry) {
      entry = { key, query, global: false, itemIds: [] };
      entries.set(key, entry);
    }
    if (global) entry.global = true;
    if (id && !entry.itemIds.includes(id)) entry.itemIds.push(id);
    return key;
  }

  for (const query of queryList(globalQueries)) {
    const key = register(query, { global: true });
    if (key && !globalKeys.includes(key)) globalKeys.push(key);
  }

  shoppingItems.forEach((item, index) => {
    const id = itemId(item, index);
    const keys = [];
    for (const query of queryList(item?.[queryField])) {
      const key = register(query, { id });
      if (key && !keys.includes(key)) keys.push(key);
    }
    itemQueues.push({ id, keys });
  });

  const selectedKeys = [];
  const selected = new Set();
  function take(key) {
    if (!key || selected.has(key) || selected.size >= budget) return false;
    selected.add(key);
    selectedKeys.push(key);
    return true;
  }

  // Fairness pass: each line gets one distinct query before any line receives
  // a second. A query already selected for another line counts when shared.
  for (const item of itemQueues) {
    if (item.keys.some((key) => selected.has(key))) continue;
    take(item.keys.find((key) => !selected.has(key)));
  }

  // Global provider/category terms are shared work, so schedule them once after
  // every line has had its first chance.
  for (const key of globalKeys) take(key);

  // Continue round-robin until all unique queries are scheduled or the provider
  // budget is exhausted.
  let advanced = true;
  while (selected.size < budget && advanced) {
    advanced = false;
    for (const item of itemQueues) {
      if (take(item.keys.find((key) => !selected.has(key)))) advanced = true;
      if (selected.size >= budget) break;
    }
  }

  const selectedEntries = selectedKeys.map((key) => entries.get(key));
  const omittedEntries = [...entries.values()].filter((entry) => !selected.has(entry.key));
  const itemCoverage = itemQueues.map((item) => {
    const planned = item.keys.filter((key) => selected.has(key)).map((key) => entries.get(key).query);
    const omitted = item.keys.filter((key) => !selected.has(key)).map((key) => entries.get(key).query);
    return {
      itemId: item.id,
      plannedQueries: planned,
      omittedQueries: omitted,
      status: item.keys.length === 0 ? "no_queries" : omitted.length ? (planned.length ? "partial" : "omitted") : "complete",
    };
  });

  return {
    queryField,
    budget,
    queries: selectedEntries.map((entry) => entry.query),
    entries: selectedEntries.map(publicEntry),
    omittedQueries: omittedEntries.map(publicEntry),
    omittedItems: itemCoverage.filter((item) => item.status === "omitted" || item.status === "no_queries").map((item) => item.itemId),
    itemCoverage,
    complete: omittedEntries.length === 0 && itemCoverage.every((item) => item.status === "complete"),
    budgetExhausted: omittedEntries.length > 0 && selected.size >= budget,
  };
}

/** Build the discovery and catalog halves of one provider retrieval plan. */
export function planProviderRetrieval({
  discoveryQueries = [],
  catalogQueries = [],
  shoppingItems = [],
  discoveryBudget = 8,
  catalogBudget = 8,
} = {}) {
  const discovery = planRoundRobinQueries({
    globalQueries: discoveryQueries,
    shoppingItems,
    queryField: "discoveryQueries",
    budget: discoveryBudget,
  });
  const catalog = planRoundRobinQueries({
    globalQueries: catalogQueries,
    shoppingItems,
    queryField: "catalogQueries",
    budget: catalogBudget,
  });
  return {
    discovery,
    catalog,
    complete: discovery.complete && catalog.complete,
    omittedItems: [...new Set([...discovery.omittedItems, ...catalog.omittedItems])],
  };
}

export const retrievalPlanInternals = { queryKey };
