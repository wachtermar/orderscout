import { CliError, discoverRestaurants, fetchMenu, normalizeMenu } from "./lib.js";
import { storesForFulfilment } from "./availability.js";

const HEALTHY_TERMS = [
  "ensalada", "salad", "poke", "bowl", "plancha", "grilled", "verdura", "vegetable",
  "pollo", "chicken", "pavo", "turkey", "salmón", "salmon", "atún", "tuna", "quinoa",
  "integral", "healthy", "saludable", "sana", "vegan", "vegano", "vegetariano",
  "fruta", "fruit", "huevo", "egg", "yogur", "yogurt", "avena", "oat", "granola",
  "aguacate", "avocado", "tostada", "toast", "açaí", "acai", "chia",
];
const INDULGENT_TERMS = [
  "frito", "fried", "burger", "hamburgues", "pizza", "donut", "tarta", "cake", "helado",
  "chocolate", "bacon", "patatas", "fries", "kebab", "mayonesa", "mayonnaise", "empanado",
  "breaded", "battered", "croqueta", "crispy", "creamy", "chips",
];
const STRONGLY_INDULGENT_TERMS = ["frito", "fried", "empanado", "breaded", "battered", "croqueta", "burger", "hamburgues", "pizza", "donut", "cake", "chips"];
const HEALTHY_ANCHOR_TERMS = ["ensalada", "salad", "poke", "bowl", "plancha", "grilled", "verdura", "vegetable", "quinoa", "integral", "healthy", "saludable", "vegan", "vegano", "vegetar", "fruta", "fruit", "huevo", "egg", "yogur", "avena", "oat", "granola", "aguacate", "avocado", "tostada", "toast", "acai", "chia"];
const DIETARY = {
  vegan: ["vegan", "vegano", "vegana"],
  vegetarian: ["vegetarian", "vegetariano", "vegetariana"],
  pescatarian: ["pescatarian", "pescetarian", "pescetariano", "pescetariana"],
  halal: ["halal"],
  kosher: ["kosher"],
  glutenFree: ["gluten free", "sin gluten"],
  lactoseFree: ["lactose free", "sin lactosa", "lactosa cero"],
  dairyFree: ["dairy free", "without dairy", "sin lacteos", "sin leche"],
  nutFree: ["nut free", "without nuts", "sin frutos secos", "sin nueces"],
  keto: ["keto", "ketogenic", "cetogenico", "cetogenica"],
  lowCarb: ["low carb", "low carbohydrate", "bajo en carbohidratos", "baja en carbohidratos"],
  noPork: ["no pork", "without pork", "sin cerdo"],
};

const NUMBER_WORDS = {
  one: 1, uno: 1, una: 1, un: 1,
  two: 2, dos: 2,
  three: 3, tres: 3,
  four: 4, cuatro: 4,
  five: 5, cinco: 5,
  six: 6, seis: 6,
  seven: 7, siete: 7,
  eight: 8, ocho: 8,
  nine: 9, nueve: 9,
  ten: 10, diez: 10,
  eleven: 11, once: 11,
  twelve: 12, doce: 12,
  thirteen: 13, trece: 13,
  fourteen: 14, catorce: 14,
  fifteen: 15, quince: 15,
  sixteen: 16, dieciseis: 16,
  seventeen: 17, diecisiete: 17,
  eighteen: 18, dieciocho: 18,
  nineteen: 19, diecinueve: 19,
  twenty: 20, veinte: 20,
};

const MEAL_PATTERN = /\b(?:food|meal|dinner|lunch|breakfast|brunch|snack|restaurant|pizza|burger|kebab|shawarma|falafel|gyros?|tandoori|sushi|tacos?|burritos?|ramen|curry|pasta|paella|risotto|noodles?|sandwich(?:es)?|wraps?|salad|poke|bowl|soup|steak|chicken|dessert|ice cream|cake|donuts?|thai|chinese|indian|italian|mexican|mediterranean|japanese|vietnamese|korean|greek|comida|cena|almuerzo|desayuno|merienda|restaurante|hamburguesa|ensalada|bocadillo|sopa|pollo|carne|pescado|postre|helado|tarta|tailandes[ao]|chin[ao]|indi[ao]|italian[ao]|mexican[ao]|mediterrane[ao]|japones[ao]|vietnamita|corean[ao]|grieg[ao]|saludable|healthy|tasty|vegetarian|vegetariano|vegan|vegano|halal)\b/;

function normalizedText(value) {
  return String(value ?? "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
}

export function isPreparedBreakfastItem(value, context = "") {
  const text = normalizedText(value);
  const contextualText = `${text} ${normalizedText(context)}`;
  const packagedIngredient = /\b(pulpa|puree?|congelad[oa]?|frozen)\b/.test(text)
    && /\b(pack|paquete|\d+(?:[.,]\d+)?\s*(?:g|kg))\b/.test(text)
    && !/\b(bowl|vaso|smoothie)\b/.test(text);
  if (packagedIngredient) return false;
  const strongBreakfast = /\b(desayuno|breakfast|brunch|tostadas?|toast|avena|oatmeal|porridge|granola|yogur|yogurt|acai|bagel|pancakes?|croissants?)\b/.test(text);
  const breakfastBowl = /\bbowl\b/.test(text)
    && /\b(acai|avena|oats?|granola|yogur|yogurt|fruta|fruit|chia)\b/.test(text);
  const preparedFruit = /\b(macedonia|fruit salad|ensalada de fruta|fruta cortada|cut fruit)\b/.test(text);
  const egg = /\b(huevos?|eggs?)\b/.test(text);
  const preparedEgg = egg
    && /\b(revueltos?|scrambled|tortilla|omelette?|benedict|benedictinos?|poche|poached|fritos?|fried|shakshuka)\b/.test(text);
  const rawOrNonFoodEgg = /\b(pack|paquete|docena|unidades?|uds?|gallina|camperos?|ecologicos?|frescos?|juego|playmobil|isbn|ean|pasta|tagliatelle|tallarines?)\b/.test(text);
  const nonBreakfastEggContext = /\b(chino|chinese|wok|sushi|thai|tandoori|kebab|gambas?|prawns?|cangrejo|crab)\b/.test(contextualText);
  return strongBreakfast || breakfastBowl || preparedFruit
    || (preparedEgg && !rawOrNonFoodEgg && !nonBreakfastEggContext);
}

export function isHealthyBreakfastItem(value) {
  const text = normalizedText(value);
  const positive = /\b(integral|wholegrain|aguacate|avocado|tomate|tomato|semillas?|seeds?|fruta|fruit|acai|avena|oats?|oatmeal|porridge|granola|yogur|yogurt|chia|huevos?|eggs?|tortilla|omelette?|smoothie)\b/.test(text);
  const indulgent = /\b(frito|fried|bacon|panceta|tocino|chocolate|donut|cake|tarta|croissant|mantequilla|butter|mermelada|jam)\b/.test(text);
  return positive && !indulgent;
}

function zonedParts(date, timeZone) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-CA", {
    timeZone, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date).filter((part) => part.type !== "literal").map((part) => [part.type, Number(part.value)]));
}

function zonedDate(year, month, day, hour, minute, timeZone) {
  const target = Date.UTC(year, month - 1, day, hour, minute, 0);
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const observed = zonedParts(new Date(instant), timeZone);
    const observedUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, observed.second);
    instant += target - observedUtc;
  }
  return new Date(instant);
}

const MONTHS = {
  january: 1, enero: 1, february: 2, febrero: 2, march: 3, marzo: 3, april: 4, abril: 4,
  may: 5, mayo: 5, june: 6, junio: 6, july: 7, julio: 7, august: 8, agosto: 8,
  september: 9, septiembre: 9, october: 10, octubre: 10, november: 11, noviembre: 11,
  december: 12, diciembre: 12,
};

const WEEKDAYS = {
  sunday: 0, domingo: 0,
  monday: 1, lunes: 1,
  tuesday: 2, martes: 2,
  wednesday: 3, miercoles: 3,
  thursday: 4, jueves: 4,
  friday: 5, viernes: 5,
  saturday: 6, sabado: 6,
};

function numberToken(value) {
  if (/^\d+$/.test(String(value))) return Number(value);
  return NUMBER_WORDS[String(value)] ?? null;
}

function partySize(normalized) {
  if (/\b(?:for|para)\s+(?:(?:my|mi)\s+)?(?:wife|husband|partner|girlfriend|boyfriend|esposa|esposo|pareja)\s+(?:and|y)\s+(?:me|myself|mi)\b/.test(normalized)) return 2;
  if (/\b(?:for|para)\s+(?:a\s+)?couple\b|\bpara\s+(?:una\s+)?pareja\b/.test(normalized)) return 2;
  const numberPattern = "(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciseis|diecisiete|dieciocho|diecinueve|veinte)";
  const peoplePattern = "(?:people|persons?|adults?|children|kids?|guests?|diners?|personas?|adultos?|ninos?|ninas?|peques|invitados?|comensales?)";
  const components = [...normalized.matchAll(new RegExp(`\\b(${numberPattern})\\s*${peoplePattern}\\b`, "g"))]
    .map((match) => numberToken(match[1])).filter((value) => Number.isInteger(value));
  if (components.length > 1) return components.reduce((sum, value) => sum + value, 0);
  const direct = normalized.match(new RegExp(`\\b(?:for(?:\\s+a)?\\s+(?:family\\s+of\\s+)?|para(?:\\s+una)?\\s+(?:familia\\s+de\\s+)?|serves?\\s+|party\\s+of\\s+|group\\s+of\\s+|grupo\\s+de\\s+)(?:a\\s+|un\\s+|una\\s+)?(${numberPattern})\\b`))
    ?? normalized.match(new RegExp(`\\b(${numberPattern})\\s*${peoplePattern}\\b`));
  return direct ? numberToken(direct[1]) : null;
}

function budgetAmount(normalized) {
  const prefix = normalized.match(/\b(?:under|below|less than|no more than|not over|up to|max(?:imum)?|budget(?: of)?|hasta|menos de|por debajo de|no mas de|maximo|presupuesto(?: de)?)\s*(?:€|eur)?\s*(\d+(?:\.\d+)?)\s*(?:€|eur(?:os?)?)?/);
  if (prefix) return Number(prefix[1]);
  const suffix = normalized.match(/(?:€\s*(\d+(?:\.\d+)?)|(\d+(?:\.\d+)?)\s*(?:€|eur(?:os?)?))\s*(?:max(?:imum)?|budget|or less|o menos|de presupuesto)\b/);
  if (suffix) return Number(suffix[1] ?? suffix[2]);
  const currency = normalized.match(/(?:€\s*(\d+(?:\.\d+)?)|\b(?:for|por)\s+(\d+(?:\.\d+)?)\s*(?:€|eur(?:os?))\b)/);
  return currency ? Number(currency[1] ?? currency[2]) : null;
}

function requestedLiters(normalized) {
  const liters = (amount, unit) => unit === "ml" ? amount / 1_000 : unit === "cl" ? amount / 100 : amount;
  const count = "(?:\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|un|una|uno|dos|tres|cuatro|cinco|seis|siete|ocho|nueve|diez|once|doce|trece|catorce|quince|dieciseis|diecisiete|dieciocho|diecinueve|veinte)";
  const pack = normalized.match(new RegExp(`\\b(${count})\\s*(?:packs?|paquetes?)\\s*(?:of|de)?\\s*(${count})\\s*(?:x|bottles?|botellas?|units?|unidades?|uds?)\\s*(?:of|de)?\\s*(\\d+(?:\\.\\d+)?)\\s*(ml|cl|l|litro|litros|litre|litres)\\b`));
  if (pack) return numberToken(pack[1]) * numberToken(pack[2]) * liters(Number(pack[3]), pack[4]);
  const multiplied = normalized.match(new RegExp(`\\b(${count})\\s*(?:x|bottles?|botellas?|units?|unidades?|uds?)\\s*(?:of|de)?\\s*(\\d+(?:\\.\\d+)?)\\s*(ml|cl|l|litro|litros|litre|litres)\\b`));
  if (multiplied) return numberToken(multiplied[1]) * liters(Number(multiplied[2]), multiplied[3]);
  const volume = normalized.match(/(\d+(?:\.\d+)?)\s*(ml|cl|l|litro|litros|litre|litres)\b/);
  return volume ? liters(Number(volume[1]), volume[2]) : 1.5;
}

function scheduledInstant(normalized, options = {}) {
  const timeZone = options.timeZone ?? "Europe/Madrid";
  const now = options.now instanceof Date ? options.now : new Date(options.now ?? Date.now());
  const explicitDate = normalized.match(/\b(\d{1,2})\s+(january|enero|february|febrero|march|marzo|april|abril|may|mayo|june|junio|july|julio|august|agosto|september|septiembre|october|octubre|november|noviembre|december|diciembre)(?:\s+(\d{4}))?\b/);
  const isoDate = normalized.match(/\b(20\d{2})-(\d{2})-(\d{2})\b/);
  const slashDate = normalized.match(/\b(\d{1,2})[\/.](\d{1,2})[\/.](20\d{2})\b/);
  const weekday = normalized.match(/\b(?:next|this|el|este|esta|proximo|proxima)?\s*(sunday|domingo|monday|lunes|tuesday|martes|wednesday|miercoles|thursday|jueves|friday|viernes|saturday|sabado)\b/);
  const relative = /\b(?:day after tomorrow|pasado manana)\b/.test(normalized) ? 2
    : /\b(?:tomorrow|manana)\b/.test(normalized) ? 1
      : /\b(?:today|hoy|tonight|esta noche)\b/.test(normalized) ? 0 : null;
  const namedClock = /\b(?:noon|mediodia)\b/.test(normalized) ? { hour: 12, minute: 0 }
    : /\b(?:midnight|medianoche)\b/.test(normalized) ? { hour: 0, minute: 0 } : null;
  const clock = normalized.match(/\b(?:at|by|before|around|sobre|a\s+las?|antes\s+de)\s*(\d{1,2})(?:(?::|\.)(\d{2}))?\s*(am|pm|h)?\b/)
    ?? normalized.match(/\b(\d{1,2})(?::|\.)(\d{2})\s*(am|pm|h)?\b/)
    ?? normalized.match(/\b(\d{1,2})\s*(am|pm|h)\b/);
  if (!clock && !namedClock) return null;
  if (!explicitDate && !isoDate && !slashDate && !weekday && relative === null) return null;
  let hour = namedClock?.hour ?? Number(clock[1]);
  const compactClock = clock && clock[2] && /^(?:am|pm|h)$/.test(clock[2]) && !clock[3];
  const minute = namedClock?.minute ?? Number(compactClock ? 0 : clock?.[2] ?? 0);
  const meridiem = compactClock ? clock[2] : clock?.[3];
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return null;
  let year; let month; let day;
  if (isoDate) [, year, month, day] = isoDate.map(Number);
  else if (slashDate) [, day, month, year] = slashDate.map(Number);
  else if (explicitDate) {
    day = Number(explicitDate[1]); month = MONTHS[explicitDate[2]];
    year = Number(explicitDate[3] ?? zonedParts(now, timeZone).year);
    if (!explicitDate[3]) {
      const provisional = zonedDate(year, month, day, hour, minute, timeZone);
      if (provisional.getTime() <= now.getTime()) year += 1;
    }
  } else if (weekday) {
    const local = zonedParts(now, timeZone);
    const today = zonedDate(local.year, local.month, local.day, 12, 0, timeZone);
    const targetWeekday = WEEKDAYS[weekday[1]];
    const currentWeekday = today.getUTCDay();
    let delta = (targetWeekday - currentWeekday + 7) % 7;
    const explicitlyNext = /\b(?:next|proximo|proxima)\b/.test(weekday[0]);
    if (explicitlyNext && delta === 0) delta = 7;
    if (delta === 0) {
      const requestedToday = zonedDate(local.year, local.month, local.day, hour, minute, timeZone);
      if (requestedToday.getTime() <= now.getTime()) delta = 7;
    }
    today.setUTCDate(today.getUTCDate() + delta);
    const target = zonedParts(today, timeZone);
    ({ year, month, day } = target);
  } else {
    const local = zonedParts(now, timeZone);
    const noon = zonedDate(local.year, local.month, local.day, 12, 0, timeZone);
    noon.setUTCDate(noon.getUTCDate() + relative);
    const target = zonedParts(noon, timeZone);
    ({ year, month, day } = target);
  }
  const result = zonedDate(Number(year), Number(month), Number(day), hour, minute, timeZone);
  if (Number.isNaN(result.getTime())) return null;
  const observed = zonedParts(result, timeZone);
  if (observed.year !== Number(year) || observed.month !== Number(month) || observed.day !== Number(day)
    || observed.hour !== hour || observed.minute !== minute) return null;
  return result.toISOString();
}

export function parseIntent(text, options = {}) {
  const normalized = normalizedText(text).replace(/,/g, ".");
  const water = /\b(?:agua|water)\b/.test(normalized)
    && !/\b(?:tonic|coconut|vitamin|flavou?red|saborizada)\s+(?:agua|water)\b/.test(normalized);
  const packagedMealProduct = /\b(?:pasta sauce|salsa (?:de|para) pasta|pasta dental|instant ramen|ramen instantaneo|frozen pizza|pizza congelada|pizza dough|masa de pizza|meal kit|kit de comida|dog food|cat food|pet food|comida para perro|comida para gato|pienso)\b/.test(normalized);
  const productCollection = /\b(?:groceries|grocery shop|breakfast shop|supplies|birthday setup|movie night|lista de compra|hacer la compra|suministros)\b/.test(normalized);
  const meal = MEAL_PATTERN.test(normalized) && !packagedMealProduct && !productCollection;
  const people = partySize(normalized);
  const scheduledAt = scheduledInstant(normalized, options);
  const occasion = /\b(?:breakfast|desayuno|brunch)\b/.test(normalized) ? "breakfast"
    : /\b(?:lunch|almuerzo)\b/.test(normalized) ? "lunch"
      : /\b(?:dinner|cena)\b/.test(normalized) ? "dinner" : null;
  return {
    text: String(text).trim(),
    normalized,
    kind: water ? "water" : meal ? "meal" : "product",
    targetLiters: water ? requestedLiters(normalized) : null,
    people: meal ? Number(people ?? 1) : null,
    healthy: /\b(?:healthy|healthier|saludables?|sanos?|sanas?|light|ligeros?|ligeras?)\b/.test(normalized),
    tasty: /\b(?:tasty|delicious|ricos?|ricas?|sabrosos?|sabrosas?|best[ -]rated|mejor valorad[oa]s?)\b/.test(normalized),
    cheap: /\b(?:cheap|cheapest|budget|baratos?|baratas?|economicos?|economicas?|best deal|mejor oferta|mas barato|menor precio)\b/.test(normalized),
    budget: budgetAmount(normalized),
    sparkling: /\b(?:sparkling|con gas|gaseosa)\b/.test(normalized),
    occasion,
    deliveryTime: scheduledAt || /\b(?:tomorrow|manana|day after tomorrow|pasado manana|later|despues|preorder|programar|next|proximo|proxima)\b/.test(normalized) ? "scheduled" : "now",
    scheduledAt,
    timeZone: options.timeZone ?? "Europe/Madrid",
    allergyMentioned: /\b(?:allergy|allergic|allergen|alergia|alergico|alergica|anaphyl)/.test(normalized),
    dietary: Object.fromEntries(Object.entries(DIETARY).map(([key, terms]) =>
      [key, terms.some((term) => normalized.includes(term))])),
  };
}

const EXPLICIT_MEAL_QUERIES = [
  ["poke", /\bpoke\b/], ["ensalada", /\b(?:ensalada|salad)\b/],
  ["pollo a la plancha", /\b(?:pollo a la plancha|grilled chicken)\b/],
  ["sushi", /\bsushi\b/], ["pizza", /\bpizza\b/],
  ["hamburguesa", /\b(?:hamburguesa|burger)\b/], ["kebab", /\bkebab\b/],
  ["tacos", /\btacos?\b/], ["vegano", /\b(?:vegan|vegano|vegana)\b/],
  ["vegetariano", /\b(?:vegetarian|vegetariano|vegetariana)\b/], ["halal", /\bhalal\b/],
];

const PRODUCT_STOPWORDS = new Set([
  "a", "an", "and", "are", "at", "be", "best", "below", "buy", "can", "cheap", "cheapest", "could",
  "deliver", "delivered", "delivery", "do", "fast", "fastest", "find", "for", "from", "get", "give", "i", "in", "is", "it", "me",
  "my", "need", "needed", "needs", "now", "of", "on", "order", "our", "please", "rated", "some",
  "something", "that", "the", "this", "today", "tomorrow", "tonight", "under", "want", "where", "which",
  "with", "would", "you",
  "ahora", "algo", "barata", "barato", "buscar", "comprar", "con", "cual", "de", "del", "donde", "el",
  "ella", "en", "entrega", "entregar", "esta", "este", "hoy", "la", "las", "lo", "los", "manana",
  "me", "mejor", "menos", "mi", "mis", "necesito", "para", "pedir", "por", "que", "rapida", "rapido",
  "su", "sus", "un", "una", "unas", "unos", "quiero",
  "available", "disponible", "eat", "eats", "eur", "glovo", "just", "max", "maximum", "uber",
]);

const PRODUCT_CATEGORIES = new Set([
  "farmacia", "pharmacy", "product", "producto", "shop", "store", "supermarket", "supermercado", "tienda",
]);

const PRODUCT_CONCEPTS = [
  {
    id: "vape",
    triggers: ["vape", "vapes", "vaper", "vapers", "vapeador", "vapeadores", "e liquid", "eliquid", "e cig", "cigarrillo electronico"],
    aliases: ["vape", "vapes", "vaper", "vapers", "vapeador", "vapeadores", "e liquid", "eliquid", "e cig", "cigarrillo electronico"],
    genericTerms: ["liquid", "liquido", "juice"],
    queryAliases: ["vape", "vaper"],
  },
  {
    id: "battery",
    triggers: ["battery", "batteries", "bateria", "baterias", "pila", "pilas"],
    aliases: ["battery", "batteries", "bateria", "baterias", "pila", "pilas"],
    genericTerms: [],
    queryAliases: ["pilas", "baterias"],
  },
  {
    id: "charger",
    triggers: ["charger", "chargers", "cargador", "cargadores"],
    aliases: ["charger", "chargers", "cargador", "cargadores"],
    genericTerms: ["phone", "mobile", "telefono", "movil"],
    queryAliases: ["cargador", "charger"],
  },
  {
    id: "diaper",
    triggers: ["diaper", "diapers", "nappy", "nappies", "panal", "panales"],
    aliases: ["diaper", "diapers", "nappy", "nappies", "panal", "panales"],
    genericTerms: [],
    queryAliases: ["panales", "diapers"],
  },
  {
    id: "toothpaste",
    triggers: ["toothpaste", "dentifrico", "pasta dental"],
    aliases: ["toothpaste", "dentifrico", "pasta dental"],
    genericTerms: [],
    queryAliases: ["pasta dental", "dentifrico"],
  },
  {
    id: "sunscreen",
    triggers: ["sunscreen", "sunblock", "protector solar", "crema solar"],
    aliases: ["sunscreen", "sunblock", "protector solar", "crema solar"],
    genericTerms: [],
    queryAliases: ["protector solar", "sunscreen"],
  },
];

const PRODUCT_PREFERENCES = [
  {
    id: "ice",
    triggers: ["ice", "icy", "hielo", "helado", "helada", "menthol", "mentol"],
    aliases: ["ice", "icy", "hielo", "helado", "helada", "menthol", "mentol", "frozen", "cool"],
    queryAliases: ["ice", "hielo", "mentol"],
  },
];

function productTokens(value) {
  return normalizedText(value).split(/[^a-z0-9]+/).filter(Boolean);
}

function singularToken(value) {
  if (value.endsWith("ies") && value.length > 4) return `${value.slice(0, -3)}y`;
  if (value.endsWith("es") && value.length > 5) return value.slice(0, -2);
  if (value.endsWith("s") && value.length > 4) return value.slice(0, -1);
  return value;
}

function phraseMatches(tokens, phrase) {
  const wanted = productTokens(phrase);
  if (!wanted.length || wanted.length > tokens.length) return false;
  return tokens.some((_, start) => wanted.every((term, offset) => {
    const actual = tokens[start + offset];
    return actual !== undefined && (actual === term || singularToken(actual) === singularToken(term));
  }));
}

function anyPhraseMatches(tokens, phrases) {
  return phrases.some((phrase) => phraseMatches(tokens, phrase));
}

function meaningfulProductTerms(value) {
  return productTokens(value).filter((term) => term.length > 1
    && !PRODUCT_STOPWORDS.has(term) && !PRODUCT_CATEGORIES.has(term) && !/^\d+(?:eur)?$/.test(term));
}

function splitProductRequest(normalized) {
  const marker = /\b(?:preferably|preferable|ideally|preferiblemente|preferible|a ser posible|if possible)\b/;
  const marked = normalized.match(marker);
  if (marked?.index !== undefined) {
    return {
      core: normalized.slice(0, marked.index),
      preference: normalized.slice(marked.index + marked[0].length),
    };
  }
  const connector = normalized.match(/\b(?:with|con)\b/);
  if (connector?.index !== undefined && meaningfulProductTerms(normalized.slice(0, connector.index)).length) {
    return {
      core: normalized.slice(0, connector.index),
      preference: normalized.slice(connector.index + connector[0].length),
    };
  }
  return { core: normalized, preference: "" };
}

export function productIntentSpec(text) {
  const intent = typeof text === "string" ? parseIntent(text) : text;
  const split = splitProductRequest(intent.normalized);
  let coreTerms = meaningfulProductTerms(split.core);
  let preferenceTerms = meaningfulProductTerms(split.preference);
  const coreTokens = productTokens(split.core);
  const concept = PRODUCT_CONCEPTS.find((candidate) => anyPhraseMatches(coreTokens, candidate.triggers)) ?? null;
  const preferenceConcepts = PRODUCT_PREFERENCES.filter((candidate) => anyPhraseMatches(
    productTokens(split.preference || intent.normalized), candidate.triggers,
  ));
  if (concept) {
    // Remove only the words that identify the broad concept. Generic form
    // qualifiers such as "liquid" in "vape liquid" must remain required so a
    // disposable vape cannot satisfy a request for e-liquid.
    const conceptTerms = new Set(concept.triggers.filter((trigger) => phraseMatches(coreTokens, trigger)).flatMap(productTokens));
    coreTerms = coreTerms.filter((term) => !conceptTerms.has(term));
  }
  if (preferenceConcepts.length) {
    const knownPreferenceTerms = new Set(preferenceConcepts.flatMap((candidate) => candidate.triggers).flatMap(productTokens));
    coreTerms = coreTerms.filter((term) => !knownPreferenceTerms.has(term));
    preferenceTerms = preferenceTerms.filter((term) => !knownPreferenceTerms.has(term));
  }
  return {
    coreText: meaningfulProductTerms(split.core).join(" "),
    preferenceText: meaningfulProductTerms(split.preference).join(" "),
    coreTerms,
    preferenceTerms,
    concept,
    preferenceConcepts,
  };
}

function productInputText(input) {
  return [
    input.item?.name, input.itemName, input.item?.description, input.item?.category, input.category,
    input.merchant?.name, input.merchantName, input.merchant?.categories, input.merchant?.cuisines,
  ].flatMap((value) => Array.isArray(value) ? value : [value]).filter(Boolean).join(" ");
}

function productQualifierText(input) {
  return [input.item?.name, input.itemName, input.item?.category, input.category]
    .flatMap((value) => Array.isArray(value) ? value : [value]).filter(Boolean).join(" ");
}

export function productRelevance(text, input) {
  const spec = text?.coreTerms ? text : productIntentSpec(text);
  const tokens = productTokens(productInputText(input));
  const qualifierTokens = productTokens(productQualifierText(input));
  const conceptMatched = spec.concept ? anyPhraseMatches(tokens, spec.concept.aliases) : false;
  const matchedCore = spec.coreTerms.filter((term) => spec.concept?.genericTerms?.includes(term)
    ? anyPhraseMatches(qualifierTokens, spec.concept.genericTerms)
    : phraseMatches(tokens, term));
  const minimumCoreMatches = spec.coreTerms.length <= 2 ? spec.coreTerms.length : Math.ceil(spec.coreTerms.length * 0.6);
  const relevant = spec.concept
    ? conceptMatched && matchedCore.length === spec.coreTerms.length
    : spec.coreTerms.length > 0 && matchedCore.length >= minimumCoreMatches;
  if (!relevant) return { relevant: false, relevance: 0, preference: 0, matchedCore: [], matchedPreference: [] };
  const matchedPreference = [
    ...spec.preferenceConcepts.filter((candidate) => anyPhraseMatches(tokens, candidate.aliases)).map((candidate) => candidate.id),
    ...spec.preferenceTerms.filter((term) => phraseMatches(tokens, term)),
  ];
  const requestedPreferences = spec.preferenceConcepts.length + spec.preferenceTerms.length;
  const preference = requestedPreferences ? Math.round((new Set(matchedPreference).size / requestedPreferences) * 100) : 0;
  const coreDenominator = Math.max(1, spec.coreTerms.length + (spec.concept ? 1 : 0));
  const relevance = Math.round(((matchedCore.length + (conceptMatched ? 1 : 0)) / coreDenominator) * 100);
  return {
    relevant: true,
    relevance,
    preference,
    matchedCore: [...(conceptMatched ? [spec.concept.id] : []), ...matchedCore],
    matchedPreference: [...new Set(matchedPreference)],
  };
}

export function providerSearchQueries(text) {
  const intent = typeof text === "string" ? parseIntent(text) : text;
  if (intent.kind === "water") return ["agua"];
  const explicit = EXPLICIT_MEAL_QUERIES.filter(([, pattern]) => pattern.test(intent.normalized)).map(([query]) => query);
  if (intent.kind === "meal") {
    if (intent.occasion === "breakfast") {
      const breakfast = intent.healthy
        ? ["desayuno saludable", "açaí", "tostada aguacate", "huevos"]
        : ["desayuno", "brunch", "tostada", "huevos"];
      return [...new Set([...explicit, ...breakfast])].slice(0, 4);
    }
    const healthy = intent.healthy ? ["poke", "ensalada", "pollo a la plancha"] : [];
    const dietary = intent.dietary.vegan ? ["vegano"]
      : intent.dietary.vegetarian ? ["vegetariano"]
        : intent.dietary.halal ? ["halal"] : [];
    return [...new Set([...explicit, ...dietary, ...healthy, ...(explicit.length || healthy.length || dietary.length ? [] : ["comida"])])].slice(0, 4);
  }
  const spec = productIntentSpec(intent);
  const core = spec.coreText || spec.coreTerms.join(" ") || intent.normalized;
  const preference = spec.preferenceText;
  const conceptQueries = spec.concept?.queryAliases ?? [];
  const preferenceQueries = spec.preferenceConcepts.flatMap((entry) => entry.queryAliases);
  const primaryAnchor = conceptQueries[0] ?? core;
  const qualifier = spec.coreTerms.join(" ");
  return [...new Set([
    preference ? `${core} ${preference}` : null,
    ...(preferenceQueries.length ? preferenceQueries.slice(0, 2).map((term) => `${primaryAnchor} ${term}`) : []),
    core,
    ...(qualifier ? conceptQueries.map((query) => `${query} ${qualifier}`) : []),
    ...conceptQueries,
  ].filter(Boolean).map((query) => query.trim()).filter(Boolean))].slice(0, 6);
}

export function parsePackVolume(value) {
  const text = normalizedText(value).replace(/,/g, ".");
  const packMatch = text.match(/\b(\d+)\s*(?:x|botellas?|unidades?|uds?\.?)(?:\s+de)?\b/)
    ?? text.match(/(?:px|pack(?:\s+de)?)\s*(\d+)\b/);
  const volumeMatches = [...text.matchAll(/(\d+(?:\.\d+)?)\s*(ml|cl|l|litros?|litres?)\b/g)];
  if (!volumeMatches.length) return null;
  const [amountText, unit] = volumeMatches.at(-1).slice(1);
  const amount = Number(amountText);
  const unitLiters = unit === "ml" ? amount / 1_000 : unit === "cl" ? amount / 100 : amount;
  const packCount = Number(packMatch?.[1] ?? 1);
  if (!(unitLiters > 0) || !(packCount > 0)) return null;
  return { unitLiters, packCount, totalLiters: unitLiters * packCount };
}

function tasteScore(restaurant) {
  const rating = Number(restaurant.rating?.starRating ?? 0);
  const count = Number(restaurant.rating?.count ?? 0);
  return Math.round((rating * 16 + Math.min(Math.log10(count + 1) * 5, 15)) * 10) / 10;
}

function healthScore(text) {
  const normalized = normalizedText(text);
  const positive = HEALTHY_TERMS.filter((term) => normalized.includes(normalizedText(term)));
  const negative = INDULGENT_TERMS.filter((term) => normalized.includes(normalizedText(term)));
  return { score: positive.length * 12 - negative.length * 9, positive, negative };
}

function matchesDietary(text, dietary) {
  const normalized = normalizedText(text);
  return Object.entries(dietary).every(([key, required]) => {
    if (!required) return true;
    return DIETARY[key].some((term) => normalized.includes(normalizedText(term)));
  });
}

function modifierConfiguration(menuData, variation) {
  const groupById = new Map((menuData.details.ModifierGroups ?? []).map((group) => [group.Id, group]));
  const setById = new Map((menuData.details.ModifierSets ?? []).map((set) => [set.Id, set.Modifier]));
  return (variation.modifierGroupIds ?? []).map((id) => {
    const group = groupById.get(id);
    return {
      id,
      name: group?.Name ?? null,
      minChoices: group?.MinChoices ?? 0,
      maxChoices: group?.MaxChoices ?? 0,
      choices: (group?.Modifiers ?? []).map((setId) => {
        const modifier = setById.get(setId);
        return {
          setId,
          id: modifier?.Id ?? setId,
          name: modifier?.Name ?? null,
          price: modifier?.AdditionPrice ?? 0,
          defaultChoices: modifier?.DefaultChoices ?? 0,
        };
      }),
    };
  });
}

function baseCandidate(restaurant, menuData, menu, category, item, variation) {
  return {
    restaurant: {
      id: restaurant.id,
      name: restaurant.name,
      slug: restaurant.uniqueName,
      rating: restaurant.rating?.starRating ?? null,
      ratingCount: restaurant.rating?.count ?? 0,
      etaMinutes: restaurant.deliveryEtaMinutes ?? null,
      distanceMeters: restaurant.driveDistanceMeters ?? null,
      open: restaurant.isOpenNowForDelivery,
      preorder: restaurant.isOpenNowForPreorder,
      deals: (restaurant.deals ?? []).map((deal) => typeof deal === "string" ? deal : deal.description).filter(Boolean),
    },
    menuGroupId: menuData.manifest.Menus?.find((entry) =>
      entry.ServiceTypes?.some((type) => normalizedText(type) === "delivery"))?.MenuGroupId
      ?? menuData.manifest.Menus?.[0]?.MenuGroupId,
    item: {
      id: item.id,
      variationId: variation.id,
      name: item.name,
      description: item.description,
      category: category.name,
      unitPrice: variation.price,
      currency: menu.currency,
    },
    modifierGroups: modifierConfiguration(menuData, variation),
  };
}

function waterCandidates(restaurant, menuData, menu, intent) {
  const candidates = [];
  for (const category of menu.categories) {
    for (const item of category.items) {
      const text = `${category.name} ${item.name} ${item.description ?? ""}`;
      const normalized = normalizedText(text);
      const isWater = /\bagua\b/.test(normalized) || normalizedText(category.name) === "aguas";
      if (!isWater || /waterm(?:e|elon)|red bull|vape|chicle|caramelo/.test(normalized)) continue;
      if (intent.sparkling && !/(con gas|sparkling|gaseosa)/.test(normalized)) continue;
      if (!intent.sparkling && /(con gas|sparkling|gaseosa)/.test(normalized)) continue;
      const volume = parsePackVolume(`${item.name} ${item.description ?? ""}`);
      if (!volume) continue;
      for (const variation of item.variations) {
        const units = Math.ceil(intent.targetLiters / volume.totalLiters);
        const suppliedLiters = units * volume.totalLiters;
        const itemTotal = Math.round(units * Number(variation.price) * 100) / 100;
        if (intent.budget !== null && itemTotal > intent.budget) continue;
        candidates.push({
          ...baseCandidate(restaurant, menuData, menu, category, item, variation),
          quantity: units,
          package: volume,
          suppliedLiters,
          requestedLiters: intent.targetLiters,
          itemTotal,
          pricePerLiter: Math.round((itemTotal / suppliedLiters) * 100) / 100,
          estimatedDeliveredTotal: null,
          ranking: {
            score: Math.round((1_000 / Math.max(itemTotal, 0.01) + tasteScore(restaurant)) * 10) / 10,
            reasons: [`${suppliedLiters} litres for €${itemTotal.toFixed(2)}`],
          },
        });
      }
    }
  }
  return candidates;
}

function mealCandidates(restaurant, menuData, menu, intent) {
  const candidates = [];
  for (const category of menu.categories) {
    for (const item of category.items) {
      const itemTitle = `${category.name} ${item.name}`;
      const itemText = `${itemTitle} ${item.description ?? ""}`;
      const text = `${restaurant.cuisines?.map((entry) => entry.name).join(" ")} ${itemText}`;
      if (!matchesDietary(text, intent.dietary)) continue;
      const health = healthScore(text);
      const normalized = normalizedText(text);
      if (intent.occasion === "breakfast" && !isPreparedBreakfastItem(itemTitle, `${item.description ?? ""} ${restaurant.cuisines?.map((entry) => entry.name).join(" ")}`)) continue;
      if (intent.occasion === "breakfast" && intent.healthy && !isHealthyBreakfastItem(itemText)) continue;
      if (intent.healthy && (health.score <= 0
        || !HEALTHY_ANCHOR_TERMS.some((term) => normalized.includes(term))
        || STRONGLY_INDULGENT_TERMS.some((term) => normalized.includes(term)))) continue;
      for (const variation of item.variations) {
        const price = Number(variation.price);
        if (!Number.isFinite(price) || (intent.budget !== null && price > intent.budget)) continue;
        const taste = tasteScore(restaurant);
        const value = Math.max(0, 25 - price);
        const score = health.score + taste + (intent.cheap ? value * 2 : value * 0.4);
        candidates.push({
          ...baseCandidate(restaurant, menuData, menu, category, item, variation),
          quantity: 1,
          itemTotal: price,
          estimatedDeliveredTotal: null,
          ranking: {
            score: Math.round(score * 10) / 10,
            healthScore: health.score,
            tasteScore: taste,
            reasons: [
              ...(health.positive.length ? [`healthy signals: ${health.positive.slice(0, 4).join(", ")}`] : []),
              ...(health.negative.length ? [`indulgent signals: ${health.negative.slice(0, 3).join(", ")}`] : []),
              restaurant.rating?.starRating ? `restaurant rating ${restaurant.rating.starRating}/5` : "restaurant is unrated",
              `item price €${price.toFixed(2)} before delivery and service fees`,
            ],
          },
        });
      }
    }
  }
  return candidates;
}

function productCandidates(restaurant, menuData, menu, intent) {
  const spec = productIntentSpec(intent);
  const candidates = [];
  for (const category of menu.categories) {
    for (const item of category.items) {
      const fit = productRelevance(spec, {
        merchant: { name: restaurant.name, cuisines: restaurant.cuisines?.map((entry) => entry.name) },
        item: { name: item.name, description: item.description, category: category.name },
      });
      if (!fit.relevant) continue;
      for (const variation of item.variations) {
        const price = Number(variation.price);
        if (!Number.isFinite(price) || (intent.budget !== null && price > intent.budget)) continue;
        const merchantScore = tasteScore(restaurant);
        const valueScore = Math.max(0, 25 - price);
        candidates.push({
          ...baseCandidate(restaurant, menuData, menu, category, item, variation),
          quantity: 1,
          itemTotal: price,
          estimatedDeliveredTotal: null,
          ranking: {
            score: Math.round((merchantScore + valueScore + fit.relevance + fit.preference * 2) * 10) / 10,
            tasteScore: merchantScore,
            relevanceScore: fit.relevance,
            preferenceScore: fit.preference,
            matchedCore: fit.matchedCore,
            matchedPreference: fit.matchedPreference,
            reasons: [
              ...(fit.matchedCore.length ? [`matched product: ${fit.matchedCore.slice(0, 4).join(", ")}`] : []),
              ...(fit.matchedPreference.length ? [`matched preference: ${fit.matchedPreference.slice(0, 4).join(", ")}`] : []),
              restaurant.rating?.starRating ? `merchant rating ${restaurant.rating.starRating}/5` : "merchant is unrated",
              `item price €${price.toFixed(2)} before delivery and service fees`,
            ],
          },
        });
      }
    }
  }
  return candidates;
}

function llmMenuCandidates(restaurant, menuData, menu) {
  const candidates = [];
  for (const category of menu.categories) {
    for (const item of category.items) {
      for (const variation of item.variations) {
        const price = Number(variation.price);
        if (!Number.isFinite(price)) continue;
        candidates.push({
          ...baseCandidate(restaurant, menuData, menu, category, item, variation),
          quantity: 1,
          itemTotal: price,
          estimatedDeliveredTotal: null,
          ranking: {
            score: tasteScore(restaurant),
            tasteScore: tasteScore(restaurant),
            reasons: [
              "Unfiltered normalized menu candidate for LLM review",
              restaurant.rating?.starRating ? `merchant rating ${restaurant.rating.starRating}/5` : "merchant is unrated",
              `item price €${price.toFixed(2)} before delivery and service fees`,
            ],
          },
        });
      }
    }
  }
  return candidates;
}

async function mapConcurrent(values, concurrency, mapper) {
  const result = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      try {
        result[index] = await mapper(values[index], index);
      } catch (error) {
        result[index] = { error };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, values.length) }, worker));
  return result;
}

export async function recommend(location, text, options = {}) {
  const intent = parseIntent(text);
  const llmMode = options.candidateMode === "llm";
  const resultLimit = Number(options.limit ?? (llmMode ? 2_000 : 10));
  const maximumLimit = llmMode ? 5_000 : 100;
  if (!Number.isInteger(resultLimit) || resultLimit < 1 || resultLimit > maximumLimit) {
    throw new CliError(`--limit must be an integer between 1 and ${maximumLimit}`);
  }
  const vertical = options.vertical ?? (intent.kind === "meal" ? "restaurants" : "all");
  const discovery = await discoverRestaurants(location, {
    serviceType: "delivery",
    vertical,
    token: options.token,
  }, options.fetchImpl);
  const maximumStores = llmMode ? 200 : 50;
  const storeLimit = Number(options.stores ?? (llmMode
    ? Math.min(maximumStores, discovery.restaurants?.length ?? maximumStores)
    : intent.kind === "meal" ? 12 : intent.kind === "product" ? 30 : 20));
  if (!Number.isInteger(storeLimit) || storeLimit < 1 || storeLimit > maximumStores) {
    throw new CliError(`--stores must be an integer between 1 and ${maximumStores}`);
  }
  const eligibleRestaurants = (discovery.restaurants ?? []).filter((restaurant) =>
    restaurant.isDelivery && !restaurant.isTemporarilyOffline);
  const shouldRequireOpen = options.open || (intent.deliveryTime === "now" && !options.includeClosed);
  const fulfilmentRestaurants = shouldRequireOpen
    ? storesForFulfilment("justeat", eligibleRestaurants, { deliveryTime: "now" })
    : eligibleRestaurants;
  let restaurants = fulfilmentRestaurants;
  if (intent.kind === "product" || llmMode) {
    const shoppingIntents = (options.shoppingIntents?.length ? options.shoppingIntents : [text])
      .map((shoppingIntent) => parseIntent(shoppingIntent));
    const merchantSpecs = shoppingIntents.filter((parsed) => parsed.kind === "product").map((parsed) => {
      const spec = productIntentSpec(parsed);
      return spec.concept ? { ...spec, coreTerms: [], preferenceTerms: [], preferenceConcepts: [] } : spec;
    });
    const merchantFit = (restaurant) => merchantSpecs.some((spec) => productRelevance(spec, {
      item: { name: restaurant.name, category: restaurant.cuisines?.map((entry) => entry.name) },
      merchant: { name: restaurant.name, cuisines: restaurant.cuisines?.map((entry) => entry.name) },
    }).relevant);
    const retail = (restaurant) => /\b(tienda|store|shop|supermerc|alimentacion|convenience|farmacia|pharmacy|retail|otros tipos)\b/
      .test(normalizedText(`${restaurant.name} ${restaurant.cuisines?.map((entry) => entry.name).join(" ")}`));
    const directlyRelevant = fulfilmentRestaurants.filter((restaurant) => merchantFit(restaurant));
    restaurants = [...new Map([
      ...directlyRelevant,
      ...restaurants.filter(retail),
      ...restaurants,
    ].map((restaurant) => [restaurant.id, restaurant])).values()];
  }
  const candidateStoreCount = restaurants.length;
  restaurants = restaurants.slice(0, storeLimit);
  const scanned = await mapConcurrent(restaurants, Number(options.concurrency ?? (llmMode ? 8 : 4)), async (restaurant) => {
    const menuData = await (options.fetchMenuImpl ?? fetchMenu)(restaurant.uniqueName, options.fetchImpl);
    const menu = normalizeMenu(menuData);
    return {
      restaurant,
      menuCacheHit: menuData.cache?.hit === true,
      menuCacheStale: menuData.cache?.stale === true,
      candidates: llmMode
        ? llmMenuCandidates(restaurant, menuData, menu)
        : intent.kind === "water"
        ? waterCandidates(restaurant, menuData, menu, intent)
        : intent.kind === "meal"
          ? mealCandidates(restaurant, menuData, menu, intent)
          : productCandidates(restaurant, menuData, menu, intent),
    };
  });
  const uniqueCandidates = new Map();
  for (const candidate of scanned.flatMap((entry) => entry?.candidates ?? [])) {
    const key = `${candidate.restaurant.id}:${candidate.item.variationId}`;
    if (!uniqueCandidates.has(key)) uniqueCandidates.set(key, candidate);
  }
  const sortedCandidates = [...uniqueCandidates.values()].sort((left, right) => {
      if (!llmMode && intent.kind === "water") {
        return left.itemTotal - right.itemTotal
          || left.pricePerLiter - right.pricePerLiter
          || right.ranking.score - left.ranking.score;
      }
      return right.ranking.score - left.ranking.score || left.itemTotal - right.itemTotal;
    });
  const diverseCandidates = [];
  const includedKeys = new Set();
  const representedRestaurants = new Set();
  for (const candidate of sortedCandidates) {
    if (representedRestaurants.has(candidate.restaurant.id)) continue;
    diverseCandidates.push(candidate);
    includedKeys.add(`${candidate.restaurant.id}:${candidate.item.variationId}`);
    representedRestaurants.add(candidate.restaurant.id);
  }
  for (const candidate of sortedCandidates) {
    const key = `${candidate.restaurant.id}:${candidate.item.variationId}`;
    if (!includedKeys.has(key)) diverseCandidates.push(candidate);
  }
  const candidates = diverseCandidates.slice(0, resultLimit)
    .map((candidate, index) => ({ ...candidate, index }));
  return {
    intent,
    location: {
      source: location.source ?? null,
      addressIndex: location.addressIndex ?? null,
      matched: location.matched,
      latitude: location.latitude,
      longitude: location.longitude,
      postcode: location.postcode ?? discovery.metaData?.postalCode,
      city: location.city ?? discovery.metaData?.area,
    },
    scope: {
      vertical,
      semanticMode: llmMode ? "llm" : "deterministic",
      discoveredStores: discovery.restaurants?.length ?? 0,
      eligibleStores: eligibleRestaurants.length,
      availableStores: shouldRequireOpen ? fulfilmentRestaurants.length : null,
      excludedUnavailableStores: shouldRequireOpen ? eligibleRestaurants.length - fulfilmentRestaurants.length : 0,
      candidateStores: candidateStoreCount,
      scannedStores: restaurants.length,
      failedMenus: scanned.filter((entry) => entry?.error).length,
      cachedMenus: scanned.filter((entry) => entry?.menuCacheHit).length,
      staleMenus: scanned.filter((entry) => entry?.menuCacheStale).length,
      liveMenus: scanned.filter((entry) => entry && !entry.error && !entry.menuCacheHit).length,
      availability: restaurants.length === 0 && shouldRequireOpen
        ? "no stores open for delivery now"
        : restaurants.every((restaurant) => restaurant.isOpenNowForDelivery)
          ? "open for delivery now"
          : "includes preorder or currently closed stores",
    },
    feeAccuracy: "Item totals exclude delivery, service, bag and small-order fees until `justeat order quote`.",
    allergenSafety: intent.allergyMentioned
      ? "Menu text is not sufficient for allergy safety. Verify directly with the restaurant before using --allergen-reviewed."
      : null,
    candidates,
  };
}
