const { searchCheapestFlightsFromOrigin, searchHotels } = require('./serpapi');
const { getActivityEstimate } = require('./gemini');
const { hashKey, get, set } = require('./cache');

async function findBestPairings({ origin, windowStart, windowEnd, stayDays, travelers = 1, currency = 'USD' }) {
  const cacheKey = hashKey({ origin, windowStart, windowEnd, stayDays, travelers });

  const cached = get(cacheKey);
  if (cached) {
    console.log(`Cache hit for key ${cacheKey.slice(0, 8)}...`);
    return cached;
  }

  console.log(`Finding pairings: ${origin} → anywhere, ${windowStart}–${windowEnd}, ${stayDays} days, ${travelers} travelers`);

  const cheapestFlights = await searchCheapestFlightsFromOrigin({
    origin,
    windowStart,
    windowEnd,
    stayDays,
    adults: travelers,
    currency,
  });

  if (!cheapestFlights.length) {
    return { trips: [], message: 'No flights found for this route and date range.' };
  }

  const tripPromises = cheapestFlights.slice(0, 10).map(async (flight) => {
    try {
      const [hotel, activitiesRaw] = await Promise.all([
        searchHotels({
          destination: flight.destination,
          checkIn: flight.departureDate,
          checkOut: flight.returnDate,
          adults: travelers,
          currency,
        }),
        getActivityEstimate({
          city: flight.destination.city,
          country: flight.destination.country,
          currency,
        }).catch(() => null), // Gemini failure must not kill the pairing
      ]);

      if (!hotel) return null;

      // Fallback if Gemini is unavailable
      const activities = activitiesRaw || {
        dailyCost: 50,
        currency,
        highlights: [`Explore ${flight.destination.city}`, 'Local food & markets', 'Cultural sightseeing'],
      };

      const flightTotal = flight.price * travelers;
      const hotelTotal = hotel.nightlyRate * stayDays * Math.ceil(travelers / 2);
      const activitiesTotal = (activities.dailyCost || 50) * stayDays * travelers;
      const grandTotal = flightTotal + hotelTotal + activitiesTotal;

      return {
        id: `${flight.destination.iata}-${flight.departureDate}`,
        destination: flight.destination,
        flight: {
          ...flight,
          totalCost: flightTotal,
        },
        hotel: {
          ...hotel,
          totalCost: hotelTotal,
        },
        activities: {
          ...activities,
          totalCost: activitiesTotal,
          perDayPerPerson: activities.dailyCost || 50,
        },
        grandTotal,
        stayDays,
        travelers,
        currency,
      };
    } catch (err) {
      console.error(`Failed to pair ${flight.destination?.city}:`, err.message);
      return null;
    }
  });

  const results = (await Promise.all(tripPromises)).filter(Boolean);
  results.sort((a, b) => a.grandTotal - b.grandTotal);

  const payload = { trips: results, generatedAt: new Date().toISOString() };
  set(cacheKey, payload);

  return payload;
}

module.exports = { findBestPairings };