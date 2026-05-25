import Anthropic from "@anthropic-ai/sdk";
import type { Application } from "express";

function getMockHotels(city: string, adults: any = 1) {
  const baseHotels = [
    {
      name: "The Grand Nomad Palace",
      image: "https://images.unsplash.com/photo-1542314831-068cd1dbfeeb?auto=format&fit=crop&q=80&w=1000",
      price: "450"
    },
    {
      name: "Urban Oasis Suites",
      image: "https://images.unsplash.com/photo-1566073771259-6a8506099945?auto=format&fit=crop&q=80&w=1000",
      price: "280"
    },
    {
      name: "Azure Bay Resort",
      image: "https://images.unsplash.com/photo-1520250497591-112f2f40a3f4?auto=format&fit=crop&q=80&w=1000",
      price: "520"
    },
    {
      name: "The Heritage Inn",
      image: "https://images.unsplash.com/photo-1551882547-ff43c63efe81?auto=format&fit=crop&q=80&w=1000",
      price: "190"
    },
    {
      name: "Skyline Boutique Hotel",
      image: "https://images.unsplash.com/photo-1582719478250-c89cae4dc85b?auto=format&fit=crop&q=80&w=1000",
      price: "310"
    },
    {
      name: "Eco-Luxe Retreat",
      image: "https://images.unsplash.com/photo-1571896349842-33c89424de2d?auto=format&fit=crop&q=80&w=1000",
      price: "240"
    }
  ];

  return Array.from({ length: 18 }).map((_, i) => {
    const base = baseHotels[i % baseHotels.length];
    const reviewWords = ["Excellent", "Very Good", "Superb", "Fabulous", "Good"];
    return {
      hotelId: `MOCK-${city}-${i}`,
      name: `${base.name} ${city}`,
      reviewWord: reviewWords[i % reviewWords.length],
      starRating: 4 + (i % 2),
      breakfast: i % 2 === 0,
      price: { total: base.price, currency: "USD" },
      address: { cityName: city || "Global" },
      image: base.image,
      reviews: 100 + (i * 50),
      avgRating: 4.2 + (i * 0.1) % 0.8,
      vfmScore: 8.2 + (i % 3) * 0.5,
      adults: Number(adults) || 1
    };
  });
}

function mapSerpProperty(prop: any, city: string, adultsNum: number): any {
  const amenities: string[] = (prop.amenities || []).map((a: string) => a.toLowerCase());

  // SerpApi overall_rating is 0-5 (Google scale); multiply by 2 for /10 scale
  const googleRating = parseFloat(prop.overall_rating || 0);
  const avgRating = googleRating > 0 ? Math.round(googleRating * 20) / 10 : 0;

  let reviewWord = "";
  if (avgRating >= 9) reviewWord = "Exceptional";
  else if (avgRating >= 8.5) reviewWord = "Excellent";
  else if (avgRating >= 8.0) reviewWord = "Very Good";
  else if (avgRating >= 7.0) reviewWord = "Good";

  const nightlyPrice = prop.rate_per_night?.extracted_lowest || 0;
  const image =
    prop.images?.[0]?.original_image ||
    prop.images?.[0]?.thumbnail ||
    `https://images.unsplash.com/photo-1566073771259-6a8506099945?auto=format&fit=crop&q=80&w=1000`;

  // Keep only transit hubs and landmarks — filter out restaurants, hotels, corporate buildings
  const transitKeywords = ["airport", "station", "metro", "railway", "terminal", "beach", "park", "mall", "fort", "temple", "museum", "lake", "centre", "center", "road", "square", "market"];
  const nearbyPlaces: string = ((prop.nearby_places || []) as any[])
    .filter((p: any) => {
      const nameLower = (p.name || "").toLowerCase();
      const hasTransit = (p.transportations || []).some((t: any) => t.type !== "Walking" || parseInt(t.duration) <= 15);
      return hasTransit && transitKeywords.some(k => nameLower.includes(k));
    })
    .slice(0, 3)
    .map((p: any) => {
      const t = (p.transportations || []).find((t: any) => t.type === "Walking") || (p.transportations || [])[0];
      return t ? `${p.name} (${t.duration} ${t.type.toLowerCase()})` : p.name;
    })
    .join(", ");

  return {
    hotelId: prop.property_token || prop.name || Math.random().toString(),
    name: prop.name || "Hotel",
    reviewWord,
    starRating: prop.extracted_hotel_class || 0,
    breakfast: amenities.some((a) => a.includes("breakfast")),
    pool: amenities.some((a) => a.includes("pool") || a.includes("swim")),
    gym: amenities.some((a) => a.includes("gym") || a.includes("fitness")),
    wifi: amenities.some((a) => a.includes("wi-fi") || a.includes("wifi") || a.includes("internet")),
    freeCancellation: amenities.some((a) => a.includes("free cancellation") || a.includes("cancel")),
    price: { total: Math.round(nightlyPrice).toString(), currency: "USD" },
    address: { cityName: city },
    image,
    reviews: parseInt(prop.reviews || 0),
    avgRating,
    vfmScore: 0,
    locationScore: 0,
    cleanlinessScore: 0,
    adults: adultsNum,
    bookingUrl: prop.link || "",
    nearbyPlaces,
    starFallbackCandidate: false
  };
}

export function setupRoutes(
  app: Application,
  anthropic: Anthropic,
  locationCache: Map<string, any>,
  hotelCache: Map<string, any>
): void {

  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/hotel-redirect", (req, res) => {
    const { name, checkIn, checkOut, adults } = req.query as Record<string, string>;

    const params = new URLSearchParams({
      ss: name || "hotel",
      group_adults: adults || "2",
      no_rooms: "1"
    });
    if (checkIn) params.set("checkin", checkIn);
    if (checkOut) params.set("checkout", checkOut);

    return res.redirect(302, `https://www.booking.com/searchresults.html?${params.toString()}`);
  });

  app.post("/api/parse-query", async (req, res) => {
    const { query } = req.body as { query: string };
    if (!query) return res.status(400).json({ error: "query is required" });

    const todayDate = new Date();
    const checkInDate = new Date(todayDate);
    checkInDate.setDate(todayDate.getDate() + 14);
    const checkOutDate = new Date(checkInDate);
    checkOutDate.setDate(checkInDate.getDate() + 5);
    const today = todayDate.toISOString().split("T")[0];
    const defaultCheckIn = checkInDate.toISOString().split("T")[0];
    const defaultCheckOut = checkOutDate.toISOString().split("T")[0];

    try {
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 512,
        system: `You are a travel search assistant. Parse the user's natural language request into a structured JSON object.
Current Date: ${today}

EXTRACTION RULES:
1. city: Full city name. Expand abbreviations (e.g. "NYC" -> "New York City").
2. adults: Number of adults. Default 1.
3. checkInDate: YYYY-MM-DD, today or later. Default ${defaultCheckIn}.
4. checkOutDate: YYYY-MM-DD, after checkInDate. Default ${defaultCheckOut}.
5. ratings: Array of star ratings. "luxury"/"top rated" -> [4,5]. "4 star" -> [4]. "3 star or better" -> [3,4,5].
6. minReviewScore: 0-10. "Excellent/Fabulous" -> 8.5, "Very Good" -> 8.0, "Good" -> 7.0.
7. highReviewCount: true ONLY if user explicitly wants "popular", "well-known", or "most reviewed" hotels. Do NOT set this for phrases like "good reviews" or "great reviews" — those indicate review quality (use minReviewScore instead).
8. breakfast/pool/gym/wifi/freeCancellation: boolean, true if mentioned. "free wifi"/"wifi included"->"wifi:true". "free cancellation"/"refundable"->"freeCancellation:true".
9. maxPrice: number if mentioned.
10. sortBy: "popularity"|"review_score"|"price_ascending"|"distance_from_search"|"value_for_money". "top rated"->"review_score", "cheapest"->"price_ascending", "central"->"distance_from_search", "value for money"->"value_for_money". Default "popularity".
11. preferences: any other specific needs as a string.

Output ONLY a valid JSON object. No markdown, no explanation.`,
        messages: [{ role: "user", content: `Request: "${query}"` }],
      });

      const text = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
      const jsonText = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
      const parsed = JSON.parse(jsonText);
      res.json(parsed);
    } catch (e: any) {
      console.error("Claude parse error:", e);
      res.status(500).json({ error: "Failed to parse query" });
    }
  });

  app.post("/api/hotels/recommend", async (req, res) => {
    const { query, hotels } = req.body as { query: string; hotels: any[] };
    if (!query || !Array.isArray(hotels) || hotels.length === 0) {
      return res.status(400).json({ error: "query and hotels are required" });
    }

    const top = hotels.slice(0, 10);
    const hotelList = top.map((h: any, i: number) => {
      const amenities = [
        h.breakfast && "breakfast included",
        h.pool && "pool",
        h.gym && "gym",
      ].filter(Boolean).join(", ");
      const nearby = h.nearbyPlaces ? `\n   Nearby: ${h.nearbyPlaces}` : "";
      const price = parseFloat(h.price?.total || "0");
      const valueScore = price > 0 && h.avgRating > 0
        ? (h.avgRating / price * 10).toFixed(2)
        : null;
      const valueStr = valueScore ? `, value score: ${valueScore} (higher = better value for money)` : "";
      return `${i + 1}. ${h.name} — ${h.starRating}★, rated ${h.avgRating}/10 (${h.reviews} reviews), $${price}/night${amenities ? `, ${amenities}` : ""}${valueStr}${nearby}`;
    }).join("\n");

    try {
      const response = await anthropic.messages.create({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 220,
        system: `You are NomadAI, a concise travel recommendation assistant.

The data you have for each hotel: name, star rating, overall rating out of 10, review count, price per night, amenities list, and nearby places with walking/transit times.
From this data you CAN reason about: overall quality (rating + reviews), value for money (price vs. star rating and rating), any amenity explicitly listed, and location/centrality (from nearby places — landmarks, metro, city areas within walking distance indicate central locations).
You cannot verify: views, room sizes, cleanliness scores, noise levels, decor — anything not derivable from the fields above.
Important: results include all hotels, not just those with confirmed amenities. If the user asked for breakfast/pool/gym/wifi and the recommended hotel doesn't list it, tell them to verify directly with the hotel.

Write 2-3 sentences:
1. Recommend the best overall hotel by name — cite rating, review count, price, and any matching listed amenities. If the user asked for value for money and the best-rated hotel is NOT the best value score, also name the best-value hotel and its price as an alternative.
2. If the user asked for anything you cannot verify (views, cleanliness, room size, central location, etc.), name each one explicitly and tell the user to check the hotel page or reviews to confirm. Do not skip or group vaguely — list them.

Rules: no markdown, no asterisks, plain text only. Never state a fact not derivable from the data.`,
        messages: [{
          role: "user",
          content: `User searched for: "${query}"\n\nTop results:\n${hotelList}`
        }]
      });

      const text = response.content[0]?.type === "text" ? response.content[0].text.trim() : "";
      res.json({ recommendation: text });
    } catch (e: any) {
      console.error("Recommend error:", e);
      res.status(500).json({ error: "Failed to generate recommendation" });
    }
  });

  app.get("/api/hotels/search", async (req, res) => {
    const hardTimeout = setTimeout(() => {
      if (!res.headersSent) {
        res.json({ data: [], note: "Search timed out. Please try again." });
      }
    }, 50000);
    res.on("finish", () => clearTimeout(hardTimeout));

    try {
      const {
        city, checkIn, checkOut, adults, ratings, breakfast, pool, gym, wifi,
        freeCancellation, maxPrice, minReviewScore, highReviewCount, sortBy
      } = req.query as any;

      const serpApiKey = process.env.SERPAPI_KEY;

      if (!city) {
        return res.status(400).json({ error: "City is required" });
      }

      if (!serpApiKey) {
        return res.json({
          data: getMockHotels(city as string, adults),
          note: "No API key found. Showing sample data."
        });
      }

      const today = new Date();
      const todayStr = today.toISOString().split("T")[0];
      const defaultArrival = new Date(today.getTime() + 86400000 * 14).toISOString().split("T")[0];
      const defaultDeparture = new Date(today.getTime() + 86400000 * 17).toISOString().split("T")[0];

      let arrival = (checkIn as string) || defaultArrival;
      let departure = (checkOut as string) || defaultDeparture;

      if (arrival < todayStr) arrival = todayStr;
      if (departure <= arrival) {
        departure = new Date(new Date(arrival).getTime() + 86400000).toISOString().split("T")[0];
      }

      const adultsNum = parseInt((adults as string) || "1", 10);

      // Always fetch with most-reviewed sort for consistent hotel pool across queries.
      // Client-side sorting handles user preferences without changing which hotels SerpApi returns.
      const serpSort = "13";

      const buildParams = (pageToken?: string) => {
        const p = new URLSearchParams({
          engine: "google_hotels",
          q: `hotels in ${city}`,
          check_in_date: arrival,
          check_out_date: departure,
          adults: String(adultsNum),
          currency: "USD",
          gl: "us",
          hl: "en",
          sort_by: serpSort,
          api_key: serpApiKey
        });

        if (ratings) {
          const ratingArr = (ratings as string).split(",").map(Number);
          // If single rating, pass hotel_class for server-side filtering
          if (ratingArr.length === 1) {
            p.set("hotel_class", String(ratingArr[0]));
          }
        }

        if (pageToken) p.set("next_page_token", pageToken);
        return p;
      };

      const fetchPage = async (pageToken?: string) => {
        const params = buildParams(pageToken);
        const url = `https://serpapi.com/search.json?${params.toString()}`;
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 15000);
        try {
          const resp = await fetch(url, { signal: ac.signal });
          clearTimeout(t);
          if (!resp.ok) {
            console.error(`SerpApi error: ${resp.status}`);
            return null;
          }
          return resp.json();
        } catch (e) {
          clearTimeout(t);
          console.error("SerpApi fetch error:", e);
          return null;
        }
      };

      // Pages must be fetched sequentially (each needs previous page's token)
      const maxPages = ratings ? 4 : 2;
      const pages: any[] = [];
      let pageToken: string | undefined = undefined;

      for (let i = 0; i < maxPages; i++) {
        const page = await fetchPage(i === 0 ? undefined : pageToken);
        if (!page) break;
        pages.push(page);
        pageToken = page.serpapi_pagination?.next_page_token;
        if (!pageToken) break;
      }

      const allProperties: any[] = pages.flatMap((p) => p?.properties || []);

      if (allProperties.length === 0) {
        if (pages.length === 0) {
          return res.json({
            data: getMockHotels(city as string, adults),
            note: "API Error. Showing sample data."
          });
        }
        return res.json({ data: [], note: "No hotels found in this location." });
      }

      console.log(`SerpApi returned ${allProperties.length} properties across ${pages.length} pages`);

      // Dedup by property_token
      const seenTokens = new Set<string>();
      const uniqueProperties = allProperties.filter((p) => {
        const token = p.property_token || p.name;
        if (!token || seenTokens.has(token)) return false;
        seenTokens.add(token);
        return true;
      });

      let finalHotels = uniqueProperties
        .map((prop) => mapSerpProperty(prop, city as string, adultsNum))
        .filter((h) => h.name && h.price?.total && parseInt(h.price.total) > 0);

      // Star rating filter
      if (ratings) {
        const allowedRatings = (ratings as string).split(",").map(Number);
        const before = finalHotels.length;
        finalHotels = finalHotels.filter(
          (h) => h.starRating === 0 || allowedRatings.includes(h.starRating)
        );
        console.log(`[Filter] starRating [${allowedRatings}]: ${before} -> ${finalHotels.length}`);
      }

      // Review score is reliable data — hard filter is correct here unlike sparse amenity data.
      if (minReviewScore) {
        const score = parseFloat(minReviewScore as string);
        const before = finalHotels.length;
        finalHotels = finalHotels.filter((h) => h.avgRating === 0 || h.avgRating >= score);
        console.log(`[Filter] minReviewScore (${score}): ${before} -> ${finalHotels.length}`);
      }

      // Max price filter
      if (maxPrice) {
        const max = parseFloat(maxPrice as string);
        const before = finalHotels.length;
        finalHotels = finalHotels.filter((h) => {
          const p = parseFloat(h.price.total);
          return isNaN(p) || p === 0 || p <= max;
        });
        console.log(`[Filter] maxPrice (${max}): ${before} -> ${finalHotels.length}`);
      }

      // Free cancellation is a hard filter (booking policy users depend on)
      if (freeCancellation === "true") {
        const before = finalHotels.length;
        finalHotels = finalHotels.filter((h) => h.freeCancellation);
        console.log(`[Filter] freeCancellation: ${before} -> ${finalHotels.length}`);
      }

      // Breakfast/pool/gym/wifi are soft sorts — SerpApi amenity coverage is sparse,
      // so filtering hard would hide hotels that have the amenity but don't list it.
      // Instead, float confirmed matches to the top.
      const hasAmenityPreference =
        breakfast === "true" || pool === "true" || gym === "true" || wifi === "true";
      if (hasAmenityPreference) {
        finalHotels.sort((a, b) => {
          const score = (h: any) =>
            (breakfast === "true" && h.breakfast ? 1 : 0) +
            (pool === "true" && h.pool ? 1 : 0) +
            (gym === "true" && h.gym ? 1 : 0) +
            (wifi === "true" && h.wifi ? 1 : 0);
          return score(b) - score(a);
        });
        console.log(`[Sort] amenity preference applied, confirmed-first`);
      }

      // High review count: soft sort only — float most-reviewed hotels to top without cutting results.
      if (highReviewCount === "true" && finalHotels.length > 1) {
        finalHotels.sort((a, b) => b.reviews - a.reviews);
        console.log(`[Sort] highReviewCount: sorted by review count desc`);
      }

      res.json({ data: finalHotels });

    } catch (error: any) {
      console.error("Hotel Search Error:", error);
      if (!res.headersSent) {
        res.json({
          data: getMockHotels(req.query.city as string, req.query.adults),
          note: "API Error. Showing sample data."
        });
      }
    }
  });

  app.get("/api/hotels/:hotelId/details", async (req, res) => {
    const { hotelId } = req.params;
    const { checkIn, checkOut, adults } = req.query as any;
    const serpApiKey = process.env.SERPAPI_KEY;

    if (!serpApiKey) {
      return res.status(503).json({ error: "API key not configured" });
    }

    try {
      const params = new URLSearchParams({
        engine: "google_hotels_property",
        property_token: hotelId,
        currency: "USD",
        gl: "us",
        hl: "en",
        api_key: serpApiKey
      });

      if (checkIn) params.set("check_in_date", checkIn);
      if (checkOut) params.set("check_out_date", checkOut);
      if (adults) params.set("adults", adults);

      const resp = await fetch(`https://serpapi.com/search.json?${params.toString()}`);
      if (!resp.ok) {
        return res.status(502).json({ error: "Property details unavailable" });
      }

      const data = await resp.json();

      const photos = (data.images || [])
        .slice(0, 25)
        .map((img: any) => img.original_image || img.thumbnail || "")
        .filter((url: string) => url.startsWith("http"));

      const facilities = (data.amenities || []).map((a: string) => ({ name: a }));

      // reviews_breakdown in SerpApi property response uses 0-5 scale
      const breakdown = data.reviews_breakdown || [];
      const reviewBreakdown = Array.isArray(breakdown)
        ? breakdown
            .map((r: any) => ({
              category: r.name || r.category || "",
              score: Math.round(parseFloat(r.value || r.score || 0) * 20) / 10
            }))
            .filter((r: any) => r.category && r.score > 0)
            .slice(0, 8)
        : [];

      res.json({
        hotelId,
        description: data.description || "",
        photos,
        facilities,
        reviewBreakdown,
        checkInTime: data.check_in_time || "",
        checkOutTime: data.check_out_time || ""
      });

    } catch (error: any) {
      console.error("Hotel Details Error:", error);
      res.status(500).json({ error: "Failed to fetch hotel details" });
    }
  });
}
