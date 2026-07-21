function scheduled(input) {
  return input?.deliveryTime === "scheduled" || input?.mode === "scheduled";
}

export function storesForFulfilment(provider, stores, fulfilment) {
  const values = Array.isArray(stores) ? stores : [];
  if (scheduled(fulfilment)) {
    if (provider === "glovo") return values.filter((store) => store.open === true || store.schedulable === true);
    return values;
  }
  if (provider === "justeat") return values.filter((store) => store.isOpenNowForDelivery === true);
  if (provider === "glovo") return values.filter((store) => store.open === true);
  if (provider === "ubereats") return values.filter((store) => store.orderable !== false);
  return [];
}

export function offerAvailableForFulfilment(offer, fulfilment) {
  if (scheduled(fulfilment)) return offer?.fulfilment?.status !== "unavailable";
  if (offer?.available !== true) return false;
  if (offer.provider !== "ubereats") return true;
  return offer.source?.merchantAvailability?.status === "available";
}

export function offersForFulfilment(offers, fulfilment) {
  return (Array.isArray(offers) ? offers : []).filter((offer) => offerAvailableForFulfilment(offer, fulfilment));
}
