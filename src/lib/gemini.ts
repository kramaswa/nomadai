const queryCache = new Map<string, any>();

export async function parseTravelQuery(query: string) {
  const normalizedQuery = query.trim().toLowerCase();
  if (queryCache.has(normalizedQuery)) {
    console.log("Returning cached travel query result for:", query);
    return queryCache.get(normalizedQuery);
  }

  try {
    const response = await fetch("/api/parse-query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query }),
    });

    const result = await response.json();
    if (!response.ok) {
      console.error("Parse query server error:", result);
      return null;
    }
    if (result?.error) {
      console.error("Parse query returned error:", result.error);
      return null;
    }

    if (result) queryCache.set(normalizedQuery, result);
    return result;
  } catch (e) {
    console.error("Parse query error:", e);
    return null;
  }
}
