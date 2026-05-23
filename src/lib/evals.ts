export interface TestCase {
  name: string;
  query: string;
  expected: {
    city?: string;
    ratings?: number[];
    breakfast?: boolean;
    pool?: boolean;
    gym?: boolean;
    maxPrice?: number;
    minReviewScore?: number;
  };
}

export const searchTestCases: TestCase[] = [
  {
    name: "Exact Star Rating",
    query: "4 star hotels in London",
    expected: { city: "London", ratings: [4] }
  },
  {
    name: "Star Rating or Better",
    query: "4 star or better hotels in Paris",
    expected: { city: "Paris", ratings: [4, 5] }
  },
  {
    name: "Price Constraint",
    query: "Hotels in NYC below $250/night",
    expected: { city: "New York City", maxPrice: 250 }
  },
  {
    name: "Multiple Amenities",
    query: "Tokyo hotels with pool, gym and free breakfast",
    expected: { city: "Tokyo", pool: true, gym: true, breakfast: true }
  },
  {
    name: "Review Score: Excellent",
    query: "Excellent hotels in Rome",
    expected: { city: "Rome", minReviewScore: 8.5 }
  },
  {
    name: "Review Score: Very Good",
    query: "Very good hotels in Barcelona",
    expected: { city: "Barcelona", minReviewScore: 8.0 }
  },
  {
    name: "Complex Query",
    query: "3 star or better hotels in Seoul with a pool below $150",
    expected: { city: "Seoul", ratings: [3, 4, 5], pool: true, maxPrice: 150 }
  }
];
