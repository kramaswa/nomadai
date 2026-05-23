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
    const { name, cc, bookingUrl, checkIn, checkOut, adults } = req.query as Record<string, string>;

    const dateQs = new URLSearchParams();
    if (checkIn) dateQs.set('checkin', checkIn);
    if (checkOut) dateQs.set('checkout', checkOut);
    dateQs.set('group_adults', adults || '2');
    dateQs.set('no_rooms', '1');
    const qs = dateQs.toString();

    if (bookingUrl && bookingUrl.startsWith('https://www.booking.com')) {
      const base = bookingUrl.split('?')[0];
      return res.redirect(302, `${base}?${qs}`);
    }

    const searchUrl = `https://www.booking.com/searchresults.html?ss=${encodeURIComponent(name || '')}&${qs}`;
    return res.redirect(302, searchUrl);
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
7. highReviewCount: true if user wants "popular" or "many reviews".
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

  app.get("/api/hotels/search", async (req, res) => {
    const hardTimeout = setTimeout(() => {
      if (!res.headersSent) {
        res.json({ data: [], note: "Search timed out. Please try again." });
      }
    }, 30000);
    res.on('finish', () => clearTimeout(hardTimeout));

    try {
      const { city, q: query, checkIn, checkOut, adults, ratings, breakfast, pool, gym, wifi, freeCancellation, maxPrice, minReviewScore, highReviewCount, sortBy } = req.query as any;
      const apiKey = process.env.RAPIDAPI_KEY;

      if (!city) {
        return res.status(400).json({ error: "City is required" });
      }

      const cacheKey = `${city}-${checkIn}-${checkOut}-${adults}-${minReviewScore}-${maxPrice}`;

      if (!apiKey) {
        return res.json({
          data: getMockHotels(city as string, adults),
          note: "No API key found. Showing sample data."
        });
      }

      let bestLocation;
      if (locationCache.has(city as string)) {
        bestLocation = locationCache.get(city as string);
        console.log(`Using cached location for ${city}`);
      } else {
        const locationResponse = await fetch(
          `https://booking-com15.p.rapidapi.com/api/v1/hotels/searchDestination?query=${encodeURIComponent(city as string)}`,
          {
            headers: {
              'x-rapidapi-key': apiKey,
              'x-rapidapi-host': 'booking-com15.p.rapidapi.com'
            }
          }
        );

        if (!locationResponse.ok) {
          const errorText = await locationResponse.text();
          if (locationResponse.status === 429) {
            return res.json({
              data: getMockHotels(city as string, adults),
              note: "RapidAPI Quota Exceeded. Showing sample data."
            });
          }
          throw new Error(`Location API failed with status ${locationResponse.status}`);
        }

        const locationData = await locationResponse.json();
        const locationList = locationData.data || [];

        if (locationList.length === 0) {
          throw new Error("Location not found");
        }

        bestLocation = locationList.find((l: any) => l.search_type === 'CITY') || locationList[0];
        locationCache.set(city as string, bestLocation);
      }

      const destId = bestLocation.dest_id;
      const searchType = bestLocation.search_type || "CITY";

      const today = new Date();
      const todayStr = today.toISOString().split('T')[0];
      const defaultArrival = new Date(today.getTime() + 86400000 * 14).toISOString().split('T')[0];
      const defaultDeparture = new Date(today.getTime() + 86400000 * 17).toISOString().split('T')[0];

      let arrival = (checkIn as string) || defaultArrival;
      let departure = (checkOut as string) || defaultDeparture;

      if (arrival < todayStr) arrival = todayStr;
      if (departure <= arrival) {
        departure = new Date(new Date(arrival).getTime() + 86400000).toISOString().split('T')[0];
      }

      const checkInDate = new Date(arrival);
      const checkOutDate = new Date(departure);
      const nights = Math.max(1, Math.ceil((checkOutDate.getTime() - checkInDate.getTime()) / (1000 * 60 * 60 * 24)));

      const adultsNum = parseInt((adults as string) || "1", 10);

      const getFetchParams = (page: string) => {
        const p = new URLSearchParams({
          dest_id: destId,
          search_type: searchType,
          arrival_date: arrival,
          departure_date: departure,
          adults: "1",
          children_age: "0,17",
          room_qty: "1",
          page_number: page,
          page_size: "25",
          units: "metric",
          temperature_unit: "f",
          languagecode: "en-us",
          currency_code: "USD",
          location: "US",
          sort_by: sortBy === 'value_for_money' ? 'review_score' : (ratings ? 'review_score' : ((sortBy as string) || "popularity"))
        });

        const filterIds: string[] = [];

        if (ratings) {
          const ratingList = (ratings as string).split(',');
          ratingList.forEach(r => filterIds.push(`class::${r}`));
        }

        if (freeCancellation === 'true') p.set('free_cancellation', '1');

        if (maxPrice) {
          const max = parseFloat(maxPrice as string);
          if (!isNaN(max)) {
            p.set('price_max', Math.round(max * nights).toString());
          }
        }

        if (minReviewScore) {
          const score = parseFloat(minReviewScore as string);
          if (score >= 9) filterIds.push('review_score::90');
          else if (score >= 8.5) filterIds.push('review_score::85');
          else if (score >= 8) filterIds.push('review_score::80');
          else if (score >= 7) filterIds.push('review_score::70');
        }

        if (filterIds.length > 0) {
          p.set('categories_filter_ids', filterIds.join(','));
        }

        return p;
      };

      const fetchPage = async (page: string, useFilters: boolean = true) => {
        const ac = new AbortController();
        const t = setTimeout(() => ac.abort(), 8000);
        try {
          const params = getFetchParams(page);
          if (!useFilters) {
            params.delete('categories_filter_ids');
            params.delete('star_rating');
            params.delete('price_max');
          }
          const url = `https://booking-com15.p.rapidapi.com/api/v1/hotels/searchHotels?${params.toString()}`;
          const resp = await fetch(url, {
            headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': 'booking-com15.p.rapidapi.com' },
            signal: ac.signal
          });
          if (!resp.ok) { console.error(`Page ${page} failed: ${resp.status}`); return null; }
          return resp.json();
        } catch (e) {
          console.error(`Page ${page} error:`, e);
          return null;
        } finally {
          clearTimeout(t);
        }
      };

      const totalPages = ratings ? 12 : 4;
      const pageNums = Array.from({ length: totalPages }, (_, i) => String(i + 1));
      let pages = await Promise.all(pageNums.map(p => fetchPage(p)));

      let allHotelsRaw = pages.flatMap(p => {
        if (!p) return [];
        if (Array.isArray(p.data)) return p.data;
        if (p.data?.hotels && Array.isArray(p.data.hotels)) return p.data.hotels;
        if (p.data?.result && Array.isArray(p.data.result)) return p.data.result;
        if (Array.isArray(p)) return p;
        return [];
      });

      if (allHotelsRaw.length === 0 && (ratings || breakfast === 'true' || pool === 'true' || gym === 'true' || wifi === 'true' || freeCancellation === 'true' || maxPrice)) {
        console.log("Narrow search returned 0. Retrying with broad search...");
        const broadPages = await Promise.all([
          fetchPage("1", false),
          fetchPage("2", false)
        ]);
        allHotelsRaw = broadPages.flatMap(p => {
          if (!p) return [];
          if (Array.isArray(p.data)) return p.data;
          if (p.data?.hotels && Array.isArray(p.data.hotels)) return p.data.hotels;
          if (p.data?.result && Array.isArray(p.data.result)) return p.data.result;
          if (Array.isArray(p)) return p;
          return [];
        });
      }

      const seenIds = new Set();
      const uniqueHotels = allHotelsRaw.filter(h => {
        const id = h.hotel_id || h.id;
        if (!id || seenIds.has(id)) return false;
        seenIds.add(id);
        return true;
      });

      console.log(`Total unique hotels fetched: ${uniqueHotels.length} | pre-filter cap: ${ratings ? 300 : 80} | enrich cap: ${ratings ? 120 : 100}`);

      if (uniqueHotels.length === 0) {
        if (pages[0] === null) {
          return res.json({
            data: getMockHotels(city as string, adults),
            note: "RapidAPI Quota Exceeded or Error. Showing sample data."
          });
        }
        return res.json({
          data: [],
          note: "No hotels found in this location."
        });
      }

      const arrivalDate = new Date(arrival);
      const departureDate = new Date(departure);
      console.log(`Calculating nightly rate for ${nights} nights (${arrival} to ${departure})`);

      const hotels = uniqueHotels.slice(0, 400).filter(h => {
        const prop = (h.property && typeof h.property === 'object') ? h.property : h;
        const starCandidates = [
          h.hotel_class, prop.hotel_class,
          h.class, prop.class,
          h.star_rating, prop.star_rating,
          h.propertyClass, prop.propertyClass,
          h.hotel_star_rating, prop.hotel_star_rating,
          h.quality_class, prop.quality_class
        ];

        let star = 0;
        for (const cand of starCandidates) {
          if (cand !== undefined && cand !== null && cand !== "") {
            const match = cand.toString().match(/(\d)/);
            if (match) {
              const val = parseInt(match[1]);
              if (val > 0 && val <= 10) {
                star = val > 5 ? Math.round(val / 2) : val;
                break;
              }
            }
          }
        }

        if (star === 0) {
          const name = (h.hotel_name || prop.name || h.name || "");
          const starMatch = name.match(/(\d)\s*(star|stars)/i);
          if (starMatch && starMatch[1]) {
            star = parseInt(starMatch[1]);
          }
        }

        if (ratings && star > 0) {
          const allowed = (ratings as string).split(',').map(Number);
          if (!allowed.includes(star)) return false;
        }

        const rawScore = parseFloat((h.reviewScore || h.review_score || h.rating || 0).toString());
        if (minReviewScore && rawScore > 0) {
          const min = parseFloat(minReviewScore as string);
          if (rawScore < (min - 0.5)) return false;
        }

        if (maxPrice) {
          const max = parseFloat(maxPrice as string);
          const rawPrice = h.price_breakdown?.gross_amount?.value || h.min_total_price || h.price || 0;
          const price = parseFloat(rawPrice.toString());
          if (price > 0) {
            const nightly = price > 1000 ? price / nights : price;
            if (nightly > max * 1.5) return false;
          }
        }

        return true;
      }).slice(0, ratings ? 300 : 80);

      if (ratings) {
        // Hotels with unknown star (=0) need enrichment to be classified — prioritize them.
        // Among known-star hotels, sort by review score descending.
        hotels.sort((a, b) => {
          const aStar = (() => {
            const cands = [a.hotel_class, a.class, a.star_rating, a.propertyClass, a.quality_class];
            for (const c of cands) { if (c) { const m = c.toString().match(/(\d)/); if (m) return parseInt(m[1]); } }
            return 0;
          })();
          const bStar = (() => {
            const cands = [b.hotel_class, b.class, b.star_rating, b.propertyClass, b.quality_class];
            for (const c of cands) { if (c) { const m = c.toString().match(/(\d)/); if (m) return parseInt(m[1]); } }
            return 0;
          })();
          // Unknown-star hotels first, then by review score desc
          if (aStar === 0 && bStar !== 0) return -1;
          if (bStar === 0 && aStar !== 0) return 1;
          const sa = parseFloat((a.reviewScore || a.review_score || a.rating || 0).toString());
          const sb = parseFloat((b.reviewScore || b.review_score || b.rating || 0).toString());
          return sb - sa;
        });
      }

      const enrichCap = ratings ? 120 : 40;
      const hotelsToEnrich = hotels.slice(0, enrichCap);
      const hasAmenityFilter = breakfast === 'true' || pool === 'true' || gym === 'true' || wifi === 'true' || freeCancellation === 'true';
      const enrichedHotels: any[] = [];

      const batchSize = 20;
      for (let i = 0; i < hotelsToEnrich.length; i += batchSize) {
        const batch = hotelsToEnrich.slice(i, i + batchSize);
        const batchResults = await Promise.all(batch.map(async (h: any) => {
          const prop = (h.property && typeof h.property === 'object') ? h.property : h;

          let priceValue = 0;
          let isAlreadyNightly = false;

          const nightlyCandidates = [
            h.price_breakdown?.gross_amount_per_night?.value,
            h.composite_price_breakdown?.gross_amount_per_night?.value,
            prop.price_breakdown?.gross_amount_per_night?.value,
            h.price_per_night,
            prop.price_per_night,
            h.gross_amount_per_night,
            prop.gross_amount_per_night
          ];

          for (const val of nightlyCandidates) {
            if (val !== undefined && val !== null) {
              const num = parseFloat(val.toString());
              if (!isNaN(num) && num > 0) {
                priceValue = num;
                isAlreadyNightly = true;
                break;
              }
            }
          }

          if (!isAlreadyNightly) {
            const totalCandidates = [
              h.price_breakdown?.gross_amount?.value,
              h.priceBreakdown?.grossPrice?.value,
              h.composite_price_breakdown?.gross_amount?.value,
              h.price_breakdown?.all_inclusive_amount?.value,
              prop.price_breakdown?.gross_amount?.value,
              prop.priceBreakdown?.grossPrice?.value,
              h.min_total_price,
              h.total_price,
              prop.total_price,
              h.price,
              prop.price
            ];

            for (const val of totalCandidates) {
              if (val !== undefined && val !== null) {
                const num = parseFloat(val.toString());
                if (!isNaN(num) && num > 0) {
                  priceValue = num;
                  break;
                }
              }
            }
          }

          if (priceValue === 0) {
            const findPriceRecursive = (obj: any): number => {
              if (!obj || typeof obj !== 'object') return 0;
              const candidates = [
                obj.value, obj.amount, obj.price,
                obj.grossPrice?.value, obj.gross_price?.value,
                obj.grossAmount?.value, obj.gross_amount?.value,
                obj.all_inclusive_amount?.value
              ];
              for (const val of candidates) {
                if (val !== undefined && val !== null) {
                  const num = parseFloat(val.toString());
                  if (!isNaN(num) && num > 0) return num;
                }
              }
              for (const key in obj) {
                if (typeof obj[key] === 'object' && obj[key] !== null && key !== 'strikethrough_price' && key !== 'original_price') {
                  const found = findPriceRecursive(obj[key]);
                  if (found > 0) return found;
                }
              }
              return 0;
            };
            priceValue = findPriceRecursive(h);
          }

          let finalNightlyPrice = isAlreadyNightly ? priceValue : (priceValue / nights);

          const totalCandidatesValues = [
            h.price_breakdown?.gross_amount?.value,
            h.priceBreakdown?.grossPrice?.value,
            h.composite_price_breakdown?.gross_amount?.value,
            prop.price_breakdown?.gross_amount?.value,
            prop.priceBreakdown?.grossPrice?.value,
            h.min_total_price,
            h.total_price,
            prop.total_price
          ].map(v => v !== undefined && v !== null ? parseFloat(v.toString()) : null).filter(v => v !== null && !isNaN(v));

          const matchesTotal = totalCandidatesValues.some(t => t === priceValue);

          if (nights > 1 && (matchesTotal || (finalNightlyPrice > 700 && isAlreadyNightly))) {
            finalNightlyPrice = priceValue / nights;
          }

          let starRating = 0;

          const starCandidates = [
            h.hotel_class, prop.hotel_class,
            h.class, prop.class,
            h.star_rating, prop.star_rating,
            h.propertyClass, prop.propertyClass,
            h.hotel_star_rating, prop.hotel_star_rating,
            h.quality_class, prop.quality_class,
            h.accommodation_type_name,
            prop.accommodation_type_name
          ];

          for (const cand of starCandidates) {
            if (cand !== undefined && cand !== null && cand !== "") {
              const match = cand.toString().match(/(\d)/);
              if (match) {
                const val = parseInt(match[1]);
                if (val > 0 && val <= 10) {
                  starRating = val > 5 ? Math.round(val / 2) : val;
                  break;
                }
              }
            }
          }

          if (starRating === 0) {
            const combined = { ...h, ...prop };
            for (const key in combined) {
              const k = key.toLowerCase();
              if (k.includes('class') || k.includes('star') || k.includes('rating')) {
                const val = combined[key];
                if (val && (typeof val === 'number' || typeof val === 'string')) {
                  const match = val.toString().match(/(\d)/);
                  if (match) {
                    const num = parseInt(match[1]);
                    if (num > 0 && num <= 7) {
                      starRating = num;
                      break;
                    }
                  }
                }
              }
            }
          }

          if (starRating === 0) {
            const name = (h.hotel_name || prop.name || h.name || "");
            const starMatch = name.match(/(\d)\s*(star|stars)/i);
            if (starMatch && starMatch[1]) {
              starRating = parseInt(starMatch[1]);
            }
          }

          if (starRating === 0) {
            const nameLower = (h.hotel_name || prop.name || "").toLowerCase();
            if (nameLower.includes('guest house') || nameLower.includes('hostel') || nameLower.includes('inn')) {
              starRating = 1;
            }
          }

          const rawScoreVal = h.reviewScore || prop.reviewScore || h.review_score || prop.review_score || h.rating || prop.rating || h.review_score_word_score || 0;
          const rawScore = parseFloat(rawScoreVal.toString());

          let reviewWord = h.reviewScoreWord || prop.reviewScoreWord || h.review_score_word || prop.review_score_word || "";
          if (!reviewWord && rawScore > 0) {
            if (rawScore >= 9) reviewWord = "Exceptional";
            else if (rawScore >= 8.5) reviewWord = "Excellent";
            else if (rawScore >= 8.0) reviewWord = "Very Good";
            else if (rawScore >= 7.0) reviewWord = "Good";
          }

          const reviewsCount = h.reviewCount || prop.reviewCount || h.review_nr || prop.review_nr || 0;

          let breakfastVal = h.is_breakfast_included || prop.is_breakfast_included || h.hotel_include_breakfast || prop.hotel_include_breakfast ||
            (h.benefits && JSON.stringify(h.benefits).toLowerCase().includes('breakfast')) ||
            (h.price_breakdown && JSON.stringify(h.price_breakdown).toLowerCase().includes('breakfast')) ||
            (h.priceBreakdown && JSON.stringify(h.priceBreakdown).toLowerCase().includes('breakfast')) || false;

          let poolVal = (h.facilities && JSON.stringify(h.facilities).toLowerCase().includes('pool')) ||
            (prop.facilities && JSON.stringify(prop.facilities).toLowerCase().includes('pool')) ||
            (h.hotel_facilities && h.hotel_facilities.toLowerCase().includes('pool')) || false;

          let gymVal = (h.facilities && JSON.stringify(h.facilities).toLowerCase().includes('gym')) ||
            (prop.facilities && JSON.stringify(prop.facilities).toLowerCase().includes('gym')) ||
            (h.facilities && JSON.stringify(h.facilities).toLowerCase().includes('fitness')) ||
            (h.hotel_facilities && h.hotel_facilities.toLowerCase().includes('fitness')) || false;

          let wifiVal = (h.facilities && JSON.stringify(h.facilities).toLowerCase().includes('wi-fi')) ||
            (h.facilities && JSON.stringify(h.facilities).toLowerCase().includes('wifi')) ||
            (prop.facilities && JSON.stringify(prop.facilities).toLowerCase().includes('wi-fi')) ||
            (h.hotel_facilities && h.hotel_facilities.toLowerCase().includes('wi-fi')) || false;

          let freeCancellationVal = h.is_free_cancellable || prop.is_free_cancellable ||
            (h.priceBreakdown?.benefitBadges && JSON.stringify(h.priceBreakdown.benefitBadges).toLowerCase().includes('free_cancellation')) || false;

          let imageUrl = "";
          const rawUrl = h.main_photo_url || prop.main_photo_url || h.max_photo_url || (Array.isArray(h.photo_urls) && h.photo_urls[0]);

          if (typeof rawUrl === 'string') {
            imageUrl = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;
          } else if (rawUrl && typeof rawUrl === 'object') {
            const objUrl = rawUrl.url || rawUrl.url_max1280x900 || "";
            imageUrl = objUrl.startsWith('//') ? `https:${objUrl}` : objUrl;
          }

          let enrichedReviewWord = reviewWord;
          let enrichedAvgRating = rawScore;
          let enrichedReviewsCount = Number(reviewsCount);
          let enrichedStarRating = starRating;
          let vfmScore = 0;
          let locationScore = 0;
          let cleanlinessScore = 0;
          let debugReason = 'No data';
          let resolvedBookingUrl = '';
          let enrichedBreakfast = !!breakfastVal;
          let enrichedPool = !!poolVal;
          let enrichedGym = !!gymVal;
          let enrichedWifi = !!wifiVal;
          let enrichedFreeCancellation = !!freeCancellationVal;

          const hotelId = (h.hotel_id || h.id || "").toString();
          if (hotelId) {
            try {
              const controller = new AbortController();
              const timeoutId = setTimeout(() => controller.abort(), 5000);

              const enrichmentPromises = [];


              enrichmentPromises.push(
                fetch(
                  `https://booking-com15.p.rapidapi.com/api/v1/hotels/getHotelPhotos?hotel_id=${hotelId}`,
                  { headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': 'booking-com15.p.rapidapi.com' }, signal: controller.signal }
                ).then(r => r.ok ? r.json() : null).then(data => {
                  const photos: any[] = data?.data || [];
                  const best = photos.find((p: any) => p.url_1440 || p.url_max || p.url_max1280x900) || photos[0];
                  if (best) {
                    const u = best.url_1440 || best.url_max || best.url_max1280x900 || best.url || "";
                    if (u) imageUrl = u.startsWith('//') ? `https:${u}` : u;
                  }
                }).catch(() => {})
              );

              enrichmentPromises.push(
                fetch(
                  `https://booking-com15.p.rapidapi.com/api/v1/hotels/getHotelReviewScores?hotel_id=${hotelId}&languagecode=en-us`,
                  {
                    headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': 'booking-com15.p.rapidapi.com' },
                    signal: controller.signal
                  }
                ).then(r => {
                  if (!r.ok) {
                    debugReason = `API Error ${r.status}`;
                    console.error(`[VFM] Enrichment failed for ${h.hotel_name || h.id}: ${r.status} ${r.statusText}`);
                  }
                  return r.ok ? r.json() : null;
                }).then(data => {
                  if (!data) {
                    if (!debugReason.includes('API Error')) debugReason = 'Empty response';
                    return;
                  }

                  const d = data.data || data;
                  if (d) {
                    enrichedReviewWord = d.score_word || enrichedReviewWord;
                    enrichedAvgRating = d.score || d.average_score || enrichedAvgRating;
                    enrichedReviewsCount = d.review_count || d.reviews_count || enrichedReviewsCount;

                    const findVfm = (obj: any, parentCustomerType?: string): any => {
                      if (!obj || typeof obj !== 'object' || obj === null) return null;

                      const currentCustomerType = obj.customer_type || parentCustomerType;

                      if (Array.isArray(obj)) {
                        const totalItem = obj.find(i => String(i?.customer_type || "").toLowerCase() === 'total');
                        if (totalItem) {
                          const found = findVfm(totalItem, 'total');
                          if (found) return found;
                        }
                        for (const item of obj) {
                          const found = findVfm(item, currentCustomerType);
                          if (found) return found;
                        }
                        return null;
                      }

                      const qField = obj.question;
                      if (typeof qField === 'string') {
                        const q = qField.toLowerCase();
                        const lq = String(obj.localized_question || "").toLowerCase();
                        if (q === 'hotel_value' || q.includes('value') || lq.includes('value') || q.includes('money')) {
                          const score = obj.score || obj.avg_score || obj.score_out_of_10;
                          if (score !== undefined && score !== null) {
                            return { ...obj, score: parseFloat(score.toString()), customer_type: currentCustomerType };
                          }
                        }
                      }

                      const priorityKeys = ['score_breakdown', 'review_score_breakdown', 'breakdown', 'customer_questions', 'question', 'data'];
                      for (const key of priorityKeys) {
                        if (obj[key]) {
                          const found = findVfm(obj[key], currentCustomerType);
                          if (found) return found;
                        }
                      }

                      for (const key in obj) {
                        if (!priorityKeys.includes(key) && typeof obj[key] === 'object' && obj[key] !== null) {
                          const found = findVfm(obj[key], currentCustomerType);
                          if (found) return found;
                        }
                      }
                      return null;
                    };

                    const vfmMatch = findVfm(d);
                    if (vfmMatch) {
                      vfmScore = vfmMatch.score || 0;
                    } else {
                      debugReason = `No VFM in keys: ${Object.keys(d).join(',').slice(0, 30)}`;
                    }

                    const extractLocationScore = (data: any): number => {
                      const root = Array.isArray(data) ? data[0] : data;
                      if (!root) return 0;

                      const breakdown = root.score_breakdown || root.review_score_breakdown || root.breakdown || [];
                      const src = Array.isArray(breakdown)
                        ? (breakdown.find((x: any) => String(x?.customer_type || '').toLowerCase() === 'total') || breakdown[0])
                        : breakdown;

                      const questions = src?.question || src?.customer_questions || src?.questions || [];
                      const qArr = Array.isArray(questions) ? questions : [];

                      for (const q of qArr) {
                        const qKey = String(q?.question || '').toLowerCase();
                        const qLabel = String(q?.localized_question || '').toLowerCase();
                        if (qKey.includes('location') || qLabel.includes('location')) {
                          const s = q?.score ?? q?.avg_score ?? q?.average_score;
                          if (s !== undefined && s !== null) return parseFloat(String(s));
                        }
                      }
                      return 0;
                    };
                    locationScore = extractLocationScore(d);

                    const root = Array.isArray(d) ? d[0] : d;
                    const breakdown = root?.score_breakdown || root?.review_score_breakdown || root?.breakdown || [];
                    const src = Array.isArray(breakdown)
                      ? (breakdown.find((x: any) => String(x?.customer_type || '').toLowerCase() === 'total') || breakdown[0])
                      : breakdown;
                    for (const q of (Array.isArray(src?.question) ? src.question : [])) {
                      const qKey = String(q?.question || '').toLowerCase();
                      const qLabel = String(q?.localized_question || '').toLowerCase();
                      if (qKey.includes('clean') || qLabel.includes('clean')) {
                        const s = q?.score ?? q?.avg_score ?? q?.average_score;
                        if (s !== undefined && s !== null) { cleanlinessScore = parseFloat(String(s)); break; }
                      }
                    }

                    if (enrichedStarRating === 0) {
                      const dStar = d.star_rating || d.hotel_class || d.class || d.quality_class;
                      if (dStar) enrichedStarRating = Number(dStar);
                    }
                  } else {
                    debugReason = 'No data object';
                  }
                }).catch(err => {
                  debugReason = `Fetch error`;
                })
              );

              await Promise.all(enrichmentPromises);
              clearTimeout(timeoutId);
            } catch (e) {
              debugReason = 'Enrichment crash';
            }
          }

          if (imageUrl && imageUrl.startsWith('http')) {
            imageUrl = imageUrl.replace(/square\d+/, 'max1280x900').replace(/max\d+x\d+/, 'max1280x900');
          } else {
            imageUrl = `https://images.unsplash.com/photo-1566073771259-6a8506099945?auto=format&fit=crop&q=80&w=1000&sig=${h.hotel_id || Math.random()}`;
          }

          return {
            hotelId: (h.hotel_id || h.id || Math.random()).toString(),
            name: h.hotel_name || prop.name || "Boutique Hotel",
            reviewWord: enrichedReviewWord,
            starRating: enrichedStarRating,
            breakfast: enrichedBreakfast,
            pool: enrichedPool,
            gym: enrichedGym,
            wifi: enrichedWifi,
            freeCancellation: enrichedFreeCancellation,
            price: {
              total: Math.round(finalNightlyPrice).toString(),
              currency: h.currency_code || h.price_breakdown?.gross_amount?.currency || h.priceBreakdown?.grossPrice?.currency || "USD"
            },
            address: { cityName: h.city_name_en || prop.city_name_en || city },
            image: imageUrl,
            reviews: Number(enrichedReviewsCount),
            avgRating: Number(enrichedAvgRating),
            vfmScore: vfmScore,
            locationScore: locationScore,
            cleanlinessScore: cleanlinessScore,
            debugInfo: vfmScore > 0 ? `VFM: ${vfmScore.toFixed(1)}` : `VFM: ${debugReason}`,
            adults: adultsNum,
            countryCode: (prop.countryCode || h.countryCode || '').toLowerCase(),
            bookingUrl: resolvedBookingUrl || h.url || prop.url || h.hotel_url || prop.hotel_url || '',
            starFallbackCandidate: enrichedStarRating === 0 && !!ratings
          };
        }));
        enrichedHotels.push(...batchResults);

      }

      const hotelsWithoutEnrichment = hotels.slice(enrichCap);
      for (const h of hotelsWithoutEnrichment) {
        const prop = (h.property && typeof h.property === 'object') ? h.property : h;

        let priceValue = 0;
        let isAlreadyNightly = false;
        const nightlyCands = [
          h.price_breakdown?.gross_amount_per_night?.value,
          h.composite_price_breakdown?.gross_amount_per_night?.value,
          prop.price_breakdown?.gross_amount_per_night?.value,
          h.price_per_night, prop.price_per_night,
          h.gross_amount_per_night, prop.gross_amount_per_night
        ];
        for (const v of nightlyCands) {
          if (v !== undefined && v !== null) { const n = parseFloat(v.toString()); if (!isNaN(n) && n > 0) { priceValue = n; isAlreadyNightly = true; break; } }
        }
        if (!isAlreadyNightly) {
          const totalCands = [
            h.price_breakdown?.gross_amount?.value, h.priceBreakdown?.grossPrice?.value,
            h.composite_price_breakdown?.gross_amount?.value, h.price_breakdown?.all_inclusive_amount?.value,
            prop.price_breakdown?.gross_amount?.value, prop.priceBreakdown?.grossPrice?.value,
            h.min_total_price, h.total_price, prop.total_price, h.price, prop.price
          ];
          for (const v of totalCands) {
            if (v !== undefined && v !== null) { const n = parseFloat(v.toString()); if (!isNaN(n) && n > 0) { priceValue = n; break; } }
          }
        }
        let finalNightlyPrice = isAlreadyNightly ? priceValue : (priceValue / nights);
        const totalCheckVals = [
          h.price_breakdown?.gross_amount?.value, h.priceBreakdown?.grossPrice?.value,
          h.composite_price_breakdown?.gross_amount?.value, prop.price_breakdown?.gross_amount?.value,
          h.min_total_price, h.total_price, prop.total_price
        ].map(v => v !== undefined && v !== null ? parseFloat(v.toString()) : null).filter(v => v !== null && !isNaN(v as number)) as number[];
        if (nights > 1 && (totalCheckVals.some(t => t === priceValue) || (finalNightlyPrice > 700 && isAlreadyNightly))) {
          finalNightlyPrice = priceValue / nights;
        }

        let starRating = 0;
        const starCands = [
          h.hotel_class, prop.hotel_class, h.class, prop.class,
          h.star_rating, prop.star_rating, h.propertyClass, prop.propertyClass,
          h.hotel_star_rating, prop.hotel_star_rating, h.quality_class, prop.quality_class
        ];
        for (const c of starCands) {
          if (c !== undefined && c !== null && c !== '') {
            const m = c.toString().match(/(\d)/);
            if (m) { const v = parseInt(m[1]); if (v > 0 && v <= 10) { starRating = v > 5 ? Math.round(v / 2) : v; break; } }
          }
        }
        if (starRating === 0) {
          const combined = { ...h, ...prop };
          for (const key in combined) {
            const k = key.toLowerCase();
            if (k.includes('class') || k.includes('star') || k.includes('rating')) {
              const val = combined[key];
              if (val && (typeof val === 'number' || typeof val === 'string')) {
                const m = val.toString().match(/(\d)/);
                if (m) { const n = parseInt(m[1]); if (n > 0 && n <= 7) { starRating = n; break; } }
              }
            }
          }
        }
        if (starRating === 0) {
          const name = (h.hotel_name || prop.name || h.name || '');
          const m = name.match(/(\d)\s*(star|stars)/i);
          if (m) starRating = parseInt(m[1]);
        }
        if (starRating === 0) {
          const nameLower = (h.hotel_name || prop.name || '').toLowerCase();
          if (nameLower.includes('guest house') || nameLower.includes('hostel') || nameLower.includes('inn')) starRating = 1;
        }

        const rawScoreVal = h.reviewScore || prop.reviewScore || h.review_score || prop.review_score || h.rating || prop.rating || 0;
        const rawScore = parseFloat(rawScoreVal.toString());
        let reviewWord = h.reviewScoreWord || prop.reviewScoreWord || h.review_score_word || prop.review_score_word || '';
        if (!reviewWord && rawScore > 0) {
          if (rawScore >= 9) reviewWord = 'Exceptional';
          else if (rawScore >= 8.5) reviewWord = 'Excellent';
          else if (rawScore >= 8.0) reviewWord = 'Very Good';
          else if (rawScore >= 7.0) reviewWord = 'Good';
        }
        const reviewsCount = h.reviewCount || prop.reviewCount || h.review_nr || prop.review_nr || 0;

        let breakfastVal = h.is_breakfast_included || prop.is_breakfast_included || h.hotel_include_breakfast || false;
        if (breakfast === 'true') breakfastVal = true;
        let poolVal = (h.facilities && JSON.stringify(h.facilities).toLowerCase().includes('pool')) || false;
        if (pool === 'true') poolVal = true;
        let gymVal = (h.facilities && JSON.stringify(h.facilities).toLowerCase().includes('gym')) || false;
        if (gym === 'true') gymVal = true;
        let wifiVal = (h.facilities && JSON.stringify(h.facilities).toLowerCase().includes('wi-fi')) || false;
        if (wifi === 'true') wifiVal = true;
        let freeCancellationVal = h.is_free_cancellable || prop.is_free_cancellable || false;
        if (freeCancellation === 'true') freeCancellationVal = true;

        const rawUrl = h.main_photo_url || prop.main_photo_url || h.max_photo_url || (Array.isArray(h.photo_urls) && h.photo_urls[0]);
        let imageUrl = '';
        if (typeof rawUrl === 'string') imageUrl = rawUrl.startsWith('//') ? `https:${rawUrl}` : rawUrl;
        else if (rawUrl && typeof rawUrl === 'object') { const u = rawUrl.url || rawUrl.url_max1280x900 || ''; imageUrl = u.startsWith('//') ? `https:${u}` : u; }
        if (!imageUrl || !imageUrl.startsWith('http')) {
          imageUrl = `https://images.unsplash.com/photo-1566073771259-6a8506099945?auto=format&fit=crop&q=80&w=1000&sig=${h.hotel_id || Math.random()}`;
        }

        enrichedHotels.push({
          hotelId: (h.hotel_id || h.id || Math.random()).toString(),
          name: h.hotel_name || prop.name || 'Boutique Hotel',
          reviewWord,
          starRating,
          breakfast: !!breakfastVal,
          pool: !!poolVal,
          gym: !!gymVal,
          wifi: !!wifiVal,
          freeCancellation: !!freeCancellationVal,
          price: { total: Math.round(finalNightlyPrice).toString(), currency: h.currency_code || 'USD' },
          address: { cityName: h.city_name_en || prop.city_name_en || city },
          image: imageUrl,
          reviews: Number(reviewsCount),
          avgRating: Number(rawScore),
          vfmScore: 0,
          locationScore: 0,
          cleanlinessScore: 0,
          debugInfo: 'no-enrich',
          adults: adultsNum,
          countryCode: (prop.countryCode || h.countryCode || '').toLowerCase(),
          bookingUrl: h.url || prop.url || h.hotel_url || prop.hotel_url || '',
          starFallbackCandidate: starRating === 0 && !!ratings
        });
      }

      if (ratings) {
        const requestedRatings = (ratings as string).split(',').map(Number).filter(n => n > 0);
        const maxRequested = Math.max(...requestedRatings);

        const confirmedPrices = enrichedHotels
          .filter(h => h.starRating > 0)
          .map(h => parseFloat(h.price?.total || '0'))
          .filter(p => p > 0)
          .sort((a, b) => a - b);

        const medianPrice = confirmedPrices.length > 0
          ? confirmedPrices[Math.floor(confirmedPrices.length / 2)]
          : 0;

        const absoluteMin = maxRequested >= 5 ? 30 : maxRequested >= 4 ? 15 : 5;
        const relativeFloor = Math.max(absoluteMin, medianPrice * 0.20);
        console.log(`[StarFallback] median confirmed: $${medianPrice.toFixed(0)}, floor: $${relativeFloor.toFixed(0)} (abs min: $${absoluteMin})`);

        enrichedHotels.forEach(h => {
          if (h.starFallbackCandidate) {
            const price = parseFloat(h.price?.total || '0');
            if (price >= relativeFloor) {
              h.starRating = requestedRatings.length === 1 ? requestedRatings[0] : maxRequested;
              console.log(`[StarFallback] accepted "${h.name}" at $${price} (floor $${relativeFloor.toFixed(0)})`);
            } else {
              console.log(`[StarFallback] rejected "${h.name}" at $${price} (below floor $${relativeFloor.toFixed(0)})`);
            }
          }
        });
      }

      const formattedHotels = enrichedHotels.filter(h => h.name && h.price?.total);

      let finalHotels = formattedHotels;
      let fallbackNote: string | undefined = undefined;
      const filterLog = [];

      if (ratings) {
        const allowedRatings = (ratings as string).split(',').map(Number);
        const before = finalHotels.length;

        // starRating=0 means we couldn't extract it from raw data — the API already filtered
        // by star class, so give these the benefit of the doubt rather than dropping them.
        finalHotels = finalHotels.filter(h => h.starRating === 0 || allowedRatings.includes(h.starRating));
        console.log(`[Filter] starRating: ${before} -> ${finalHotels.length}`);

        const maxStar = Math.max(...allowedRatings);

        const minReviews = maxStar >= 5 ? 5 : maxStar >= 4 ? 3 : 0;
        if (minReviews > 0) {
          const b2 = finalHotels.length;
          finalHotels = finalHotels.filter(h => (h.reviews || 0) >= minReviews);
          console.log(`[Filter] minReviews(${minReviews}): ${b2} -> ${finalHotels.length}`);
        }

        const minScore = maxStar >= 5 ? 7.0 : maxStar >= 4 ? 6.0 : 0;
        if (minScore > 0) {
          const b3 = finalHotels.length;
          finalHotels = finalHotels.filter(h => h.avgRating === 0 || h.avgRating >= minScore);
          console.log(`[Filter] minScore(${minScore}): ${b3} -> ${finalHotels.length}`);
        }

        const allPrices = finalHotels.map(h => parseFloat(h.price?.total || '0')).filter(p => p > 0).sort((a, b) => a - b);
        if (allPrices.length > 2) {
          const b4 = finalHotels.length;
          const median = allPrices[Math.floor(allPrices.length / 2)];
          const priceFloor = median * (maxStar >= 5 ? 0.08 : 0.06);
          finalHotels = finalHotels.filter(h => parseFloat(h.price?.total || '0') >= priceFloor);
          console.log(`[Filter] priceFloor($${priceFloor.toFixed(0)}): ${b4} -> ${finalHotels.length}`);
        }

        filterLog.push(`Ratings [${allowedRatings}]: ${before} -> ${finalHotels.length}`);
      }

      if (hasAmenityFilter && finalHotels.length > 0 && finalHotels.length <= 80) {
        console.log(`[Amenity] fetching facilities for ${finalHotels.length} hotels in parallel batches...`);
        const amenityBatchSize = 10;
        for (let i = 0; i < finalHotels.length; i += amenityBatchSize) {
          const amenityBatch = finalHotels.slice(i, i + amenityBatchSize);
          await Promise.all(amenityBatch.map(async (hotel: any) => {
            try {
              const ac = new AbortController();
              const t = setTimeout(() => ac.abort(), 3000);
              const r = await fetch(
                `https://booking-com15.p.rapidapi.com/api/v1/hotels/getHotelFacilities?hotel_id=${hotel.hotelId}`,
                { headers: { 'x-rapidapi-key': apiKey, 'x-rapidapi-host': 'booking-com15.p.rapidapi.com' }, signal: ac.signal }
              );
              clearTimeout(t);
              if (r.ok) {
                const data = await r.json();
                const raw: any[] = data?.data || [];
                if (Array.isArray(raw) && raw.length > 0) {
                  const allNames = raw.flatMap((group: any) => {
                    const gName = (group.facilitytype_name || group.name || '').toLowerCase();
                    const items = group.facilities || group.items || [];
                    const iNames = Array.isArray(items) ? items.map((f: any) => (f.name || '').toLowerCase()) : [];
                    return [gName, ...iNames];
                  }).join(' ');
                  hotel.pool = allNames.includes('pool') || allNames.includes('swimming');
                  hotel.gym = allNames.includes('gym') || allNames.includes('fitness');
                  hotel.wifi = allNames.includes('wi-fi') || allNames.includes('wifi') || allNames.includes('internet');
                  hotel.breakfast = allNames.includes('breakfast') || allNames.includes('restaurant');
                }
              }
            } catch {}
          }));
        }
        const beforeAmenity = finalHotels.length;
        if (breakfast === 'true') finalHotels = finalHotels.filter(h => h.breakfast);
        if (pool === 'true') finalHotels = finalHotels.filter(h => h.pool);
        if (gym === 'true') finalHotels = finalHotels.filter(h => h.gym);
        if (wifi === 'true') finalHotels = finalHotels.filter(h => h.wifi);
        if (freeCancellation === 'true') finalHotels = finalHotels.filter(h => h.freeCancellation);
        console.log(`[Amenity] filter: ${beforeAmenity} -> ${finalHotels.length}`);
        filterLog.push(`Amenities: ${beforeAmenity} -> ${finalHotels.length}`);
      }

      if (maxPrice) {
        const max = parseFloat(maxPrice as string);
        const before = finalHotels.length;
        finalHotels = finalHotels.filter(h => {
          const price = parseFloat(h.price.total);
          return !isNaN(price) && price <= max;
        });
        filterLog.push(`MaxPrice [${max}]: ${before} -> ${finalHotels.length}`);
      }

      if (minReviewScore) {
        const score = parseFloat(minReviewScore as string);
        const before = finalHotels.length;
        finalHotels = finalHotels.filter(h => {
          return h.avgRating >= score;
        });
        filterLog.push(`MinScore [${score}]: ${before} -> ${finalHotels.length}`);
      }

      if (highReviewCount === 'true' && finalHotels.length > 0) {
        const before = finalHotels.length;
        const sortedByReviews = [...finalHotels].sort((a, b) => b.reviews - a.reviews);
        const topCount = Math.max(1, Math.ceil(sortedByReviews.length * 0.25));
        const top25Threshold = sortedByReviews[topCount - 1].reviews;
        finalHotels = finalHotels.filter(h => h.reviews >= top25Threshold);
        filterLog.push(`HighReviewCount: ${before} -> ${finalHotels.length} (Threshold: ${top25Threshold})`);
      }

      console.log(`Filtering Summary: ${filterLog.join(' | ')}`);

      if (sortBy === 'value_for_money' && finalHotels.length > 0) {
        finalHotels.sort((a, b) => {
          return (b.vfmScore || 0) - (a.vfmScore || 0);
        });
        console.log("Applied 'Value for Money' custom sort using API breakdown.");
      }

      if (finalHotels.length === 0 && formattedHotels.length > 0) {
        console.log("Filtering resulted in 0 hotels. Attempting intelligent fallback.");

        let fallback = [...formattedHotels];
        let ratingFallbackUsed = false;

        if (ratings) {
          const allowedRatings = (ratings as string).split(',').map(Number);
          const ratingMatch = formattedHotels.filter(h => allowedRatings.includes(h.starRating));
          if (ratingMatch.length > 0) {
            fallback = ratingMatch;
            console.log(`Fallback (Enriched + Ratings): ${formattedHotels.length} -> ${fallback.length}`);
          } else {
            ratingFallbackUsed = true;
            fallback = formattedHotels;
            console.log(`No enriched hotels found with ratings ${allowedRatings}. Showing other enriched hotels.`);
          }
        }

        if (maxPrice && fallback.length > 0) {
          const max = parseFloat(maxPrice as string);
          const priceMatch = fallback.filter(h => {
            const price = parseFloat(h.price.total);
            return !isNaN(price) && price <= max;
          });
          if (priceMatch.length > 0) {
            fallback = priceMatch;
          }
        }

        if (fallback.length > 0) {
          console.log(`Fallback: Found ${fallback.length} hotels matching core criteria.`);
          finalHotels = fallback;

          if (ratingFallbackUsed) {
            const requestedStars = (ratings as string).split(',').join(', ');
            fallbackNote = `No ${requestedStars} star hotels were found, but here are some other hotels you may like.`;
          } else {
            fallbackNote = "Showing results matching your core criteria (some amenities may not be available).";
          }
        }
      }

      hotelCache.set(cacheKey, finalHotels);
      res.json({
        data: finalHotels,
        note: fallbackNote || (finalHotels.length === 0 ? "No hotels found matching your criteria." : undefined)
      });

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
    const apiKey = process.env.RAPIDAPI_KEY;

    if (!apiKey) {
      return res.status(503).json({ error: "API key not configured" });
    }

    const headers = {
      "x-rapidapi-key": apiKey,
      "x-rapidapi-host": "booking-com15.p.rapidapi.com"
    };

    try {
      const [descRes, photosRes, facilitiesRes, reviewsRes] = await Promise.allSettled([
        fetch(
          `https://booking-com15.p.rapidapi.com/api/v1/hotels/getDescriptionAndInfo?hotel_id=${hotelId}&languagecode=en-us`,
          { headers }
        ).then(r => r.json()),
        fetch(
          `https://booking-com15.p.rapidapi.com/api/v1/hotels/getHotelPhotos?hotel_id=${hotelId}`,
          { headers }
        ).then(r => r.json()),
        fetch(
          `https://booking-com15.p.rapidapi.com/api/v1/hotels/getHotelFacilities?hotel_id=${hotelId}`,
          { headers }
        ).then(r => r.json()),
        fetch(
          `https://booking-com15.p.rapidapi.com/api/v1/hotels/getHotelReviewScores?hotel_id=${hotelId}`,
          { headers }
        ).then(r => r.json()),
      ]);

      let description = "";
      let checkInTime = "";
      let checkOutTime = "";
      if (descRes.status === "fulfilled") {
        const d = descRes.value?.data;
        if (Array.isArray(d)) {
          const mainDesc = d.find((x: any) => x.description_type === "description" || x.languagecode === "en");
          description = mainDesc?.description || d[0]?.description || "";
        } else if (typeof d === "string") {
          description = d;
        } else if (d?.description) {
          description = d.description;
        }
        const info = descRes.value?.data;
        if (Array.isArray(info)) {
          const checkinInfo = info.find((x: any) => x.description_type === "checkin" || x.description_type === "policies");
          if (checkinInfo?.description) {
            const ciMatch = checkinInfo.description.match(/check[- ]?in[:\s]+([0-9]{1,2}:[0-9]{2}\s*(?:AM|PM)?)/i);
            const coMatch = checkinInfo.description.match(/check[- ]?out[:\s]+([0-9]{1,2}:[0-9]{2}\s*(?:AM|PM)?)/i);
            if (ciMatch) checkInTime = ciMatch[1];
            if (coMatch) checkOutTime = coMatch[1];
          }
        }
      }

      let photos: string[] = [];
      if (photosRes.status === "fulfilled") {
        const rawPhotos = photosRes.value?.data || photosRes.value || [];
        const photoArr = Array.isArray(rawPhotos) ? rawPhotos : [];
        photos = photoArr
          .slice(0, 25)
          .map((p: any) => {
            const url = p.url_1440 || p.url_max || p.url || "";
            return url.replace(/square\d+/, "max1280x900").replace(/max\d+x\d+/, "max1280x900");
          })
          .filter((u: string) => u.startsWith("http"));
      }

      let facilities: { name: string; icon?: string }[] = [];
      if (facilitiesRes.status === "fulfilled") {
        const raw = facilitiesRes.value?.data || [];
        if (Array.isArray(raw)) {
          facilities = raw.flatMap((group: any) => {
            const items = group.facilities || group.items || [];
            return Array.isArray(items)
              ? items.map((f: any) => ({ name: f.name || f.facilitytype_name || f.facility_name || String(f) }))
              : [];
          }).slice(0, 40);
          if (facilities.length === 0) {
            facilities = raw.slice(0, 40).map((f: any) => ({
              name: f.name || f.facilitytype_name || f.facility_name || String(f)
            }));
          }
        }
      }

      let reviewBreakdown: { category: string; score: number }[] = [];
      if (reviewsRes.status === "fulfilled") {
        const rd = reviewsRes.value?.data;
        const findBreakdown = (obj: any): any[] => {
          if (!obj || typeof obj !== "object") return [];
          if (Array.isArray(obj)) {
            for (const item of obj) {
              const found = findBreakdown(item);
              if (found.length > 0) return found;
            }
          }
          const candidate = obj.score_breakdown || obj.review_score_breakdown || obj.breakdown || obj.customer_questions;
          if (Array.isArray(candidate) && candidate.length > 0) return candidate;
          for (const key of Object.keys(obj)) {
            const found = findBreakdown(obj[key]);
            if (found.length > 0) return found;
          }
          return [];
        };

        const totalEntry = Array.isArray(rd)
          ? rd.find((x: any) => String(x?.customer_type || "").toLowerCase() === "total") || rd[0]
          : rd;

        const items = findBreakdown(totalEntry);
        reviewBreakdown = items
          .map((item: any) => ({
            category: item.localized_question || item.question || "",
            score: parseFloat(String(item.score || item.avg_score || 0))
          }))
          .filter((x: any) => x.category && x.score > 0)
          .slice(0, 8);
      }

      res.json({
        hotelId,
        description,
        photos,
        facilities,
        reviewBreakdown,
        checkInTime,
        checkOutTime
      });
    } catch (error: any) {
      console.error("Hotel Details Error:", error);
      res.status(500).json({ error: "Failed to fetch hotel details" });
    }
  });
}
