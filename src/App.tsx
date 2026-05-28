import React, { createContext, useContext, useEffect, useState } from 'react';
import { BrowserRouter as Router, Routes, Route, Link, useNavigate, useSearchParams, useParams, useLocation } from 'react-router-dom';
import { onAuthStateChanged, signInWithPopup, GoogleAuthProvider, signOut, User } from 'firebase/auth';
import { doc, getDoc, setDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { auth, db } from './firebase';
import { parseTravelQuery } from './lib/gemini';
import { Search, User as UserIcon, Heart, LogOut, Star, MapPin, Coffee, CreditCard, Loader2, Sparkles, Waves, Dumbbell, ArrowLeft, ChevronLeft, ChevronRight, X, Check, Wifi, Car } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { toast, Toaster } from 'sonner';

// --- Types ---
interface Hotel {
  hotelId: string;
  name: string;
  reviewWord?: string;
  starRating?: number;
  breakfast?: boolean;
  pool?: boolean;
  gym?: boolean;
  wifi?: boolean;
  freeCancellation?: boolean;
  price?: {
    total: string;
    currency: string;
  };
  address?: {
    cityName: string;
  };
  image?: string;
  reviews?: number;
  avgRating?: number;
  vfmScore?: number;
  locationScore?: number;
  cleanlinessScore?: number;
  debugInfo?: string;
  adults?: number;
  countryCode?: string;
  bookingUrl?: string;
}

interface UserProfile {
  uid: string;
  email: string;
  displayName: string;
  preferences?: string;
}

// --- Context ---
const AuthContext = createContext<{
  user: User | null;
  profile: UserProfile | null;
  loading: boolean;
  signIn: () => Promise<void>;
  logout: () => Promise<void>;
  updateProfile: (updates: Partial<UserProfile>) => void;
}>({
  user: null,
  profile: null,
  loading: true,
  signIn: async () => {},
  logout: async () => {},
  updateProfile: () => {},
});

const useAuth = () => useContext(AuthContext);

// --- Error Handling ---
enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

function handleFirestoreError(error: unknown, operationType: OperationType, path: string | null) {
  const errInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
    },
    operationType,
    path
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

// --- Components ---

const Navbar = () => {
  const { user, profile, signIn, logout } = useAuth();

  return (
    <nav className="fixed top-0 left-0 right-0 z-50 bg-black/50 backdrop-blur-md border-b border-white/10 px-6 py-4 flex justify-between items-center">
      <Link to="/" className="text-2xl font-light tracking-tighter text-white flex items-center gap-2">
        <Sparkles className="w-6 h-6 text-orange-500" />
        CONCIERGE<span className="font-bold">AI</span>
      </Link>
      
      <div className="flex items-center gap-6">
        {user ? (
          <>
            <Link to="/profile" className="text-sm font-medium text-white/70 hover:text-white transition-colors flex items-center gap-2">
              <UserIcon className="w-4 h-4" />
              {profile?.displayName || 'Profile'}
            </Link>
            <button onClick={logout} className="text-sm font-medium text-white/70 hover:text-white transition-colors flex items-center gap-2">
              <LogOut className="w-4 h-4" />
              Logout
            </button>
          </>
        ) : (
          <button onClick={signIn} className="bg-white text-black px-4 py-2 rounded-full text-sm font-bold hover:bg-white/90 transition-colors">
            Sign In
          </button>
        )}
      </div>
    </nav>
  );
};

const Hero = () => {
  const location = useLocation();
  const { profile } = useAuth();
  const [query, setQuery] = useState((location.state as any)?.prefill || '');
  const [isSearching, setIsSearching] = useState(false);
  const [clarifying, setClarifying] = useState(false);
  const [clarificationQuestion, setClarificationQuestion] = useState('');
  const [clarificationAnswer, setClarificationAnswer] = useState('');
  const [pendingQuery, setPendingQuery] = useState('');
  const navigate = useNavigate();

  const runSearch = async (fullQuery: string) => {
    setIsSearching(true);
    try {
      const parsed = await parseTravelQuery(fullQuery, profile?.preferences);
      if (parsed) {
        const params = new URLSearchParams({
          city: parsed.city,
          adults: parsed.adults.toString(),
          checkIn: parsed.checkInDate,
          checkOut: parsed.checkOutDate,
          q: fullQuery
        });
        if (parsed.ratings && parsed.ratings.length > 0) params.set('ratings', parsed.ratings.join(','));
        if (parsed.breakfast) params.set('breakfast', 'true');
        if (parsed.pool) params.set('pool', 'true');
        if (parsed.gym) params.set('gym', 'true');
        if (parsed.wifi) params.set('wifi', 'true');
        if (parsed.freeCancellation) params.set('freeCancellation', 'true');
        if (parsed.maxPrice) params.set('maxPrice', parsed.maxPrice.toString());
        if (parsed.minReviewScore) params.set('minReviewScore', parsed.minReviewScore.toString());
        if (parsed.highReviewCount) params.set('highReviewCount', 'true');
        if (parsed.sortBy) params.set('sortBy', parsed.sortBy);
        if (parsed.neighborhood) params.set('neighborhood', parsed.neighborhood);
        navigate(`/search?${params.toString()}`);
      } else {
        toast.error("Please include a city in your search — e.g. 'A romantic stay in Bali with a pool'");
      }
    } catch (err: any) {
      toast.error(err?.message || "Search failed. Please try again.");
    } finally {
      setIsSearching(false);
    }
  };

  const handleSearch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!query.trim()) return;

    setIsSearching(true);
    try {
      const res = await fetch('/api/check-ambiguity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query })
      });
      const { needsClarification, question } = await res.json();

      if (needsClarification && question) {
        setPendingQuery(query);
        setClarificationQuestion(question);
        setClarificationAnswer('');
        setClarifying(true);
        setIsSearching(false);
        return;
      }
    } catch {
      // if ambiguity check fails, proceed with search anyway
    }

    setIsSearching(false);
    await runSearch(query);
  };

  const handleClarificationSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!clarificationAnswer.trim()) return;
    setClarifying(false);
    const fullQuery = `${pendingQuery}. ${clarificationAnswer}`;
    await runSearch(fullQuery);
  };

  return (
    <div className="relative h-[80vh] flex flex-col items-center justify-center px-6 overflow-hidden">
      <div className="absolute inset-0 z-0">
        <img
          src="https://images.unsplash.com/photo-1762759448938-154b640cefbf?fm=jpg&q=80&w=2000&auto=format&fit=crop"
          className="w-full h-full object-cover"
          alt="Travel"
          referrerPolicy="no-referrer"
        />
        <div className="absolute inset-0 bg-gradient-to-b from-black via-transparent to-black" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="relative z-10 text-center max-w-4xl w-full"
      >
        <h1 className="text-6xl md:text-8xl font-light tracking-tighter text-white mb-8 leading-none">
          Your perfect stay, <span className="italic font-serif">found.</span>
        </h1>

        {!clarifying ? (
          <form onSubmit={handleSearch} className="relative group">
            <textarea
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Describe your perfect stay in plain English..."
              className="w-full bg-white/10 backdrop-blur-xl border border-white/20 rounded-3xl p-8 pt-10 text-xl text-white placeholder:text-white/30 focus:outline-none focus:border-white/40 transition-all resize-none h-48"
            />
            <button
              type="submit"
              disabled={isSearching}
              className="absolute bottom-6 right-6 bg-white text-black px-8 py-3 rounded-full font-bold flex items-center gap-2 hover:scale-105 active:scale-95 transition-all disabled:opacity-50"
            >
              {isSearching ? <Loader2 className="w-5 h-5 animate-spin" /> : <Search className="w-5 h-5" />}
              {isSearching ? 'Analyzing...' : 'Search'}
            </button>
            <div className="absolute top-4 left-8 flex items-center gap-2 text-white/40 text-xs uppercase tracking-widest font-bold">
              <Sparkles className="w-3 h-3" />
              AI Powered Search
            </div>
          </form>
        ) : (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white/10 backdrop-blur-xl border border-orange-500/40 rounded-3xl p-8"
          >
            <div className="flex items-center gap-2 text-orange-400 text-xs uppercase tracking-widest font-bold mb-4">
              <Sparkles className="w-3 h-3" />
              ConciergeAI
            </div>
            <p className="text-white text-xl mb-6 text-left">{clarificationQuestion}</p>
            <form onSubmit={handleClarificationSubmit} className="flex gap-3">
              <input
                autoFocus
                value={clarificationAnswer}
                onChange={(e) => setClarificationAnswer(e.target.value)}
                placeholder="Type your answer..."
                className="flex-1 bg-white/10 border border-white/20 rounded-full px-6 py-3 text-white placeholder:text-white/30 focus:outline-none focus:border-white/40 transition-all"
              />
              <button
                type="submit"
                disabled={isSearching || !clarificationAnswer.trim()}
                className="bg-orange-500 text-white px-6 py-3 rounded-full font-bold flex items-center gap-2 hover:scale-105 active:scale-95 transition-all disabled:opacity-50"
              >
                {isSearching ? <Loader2 className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
                Search
              </button>
            </form>
            <button onClick={() => setClarifying(false)} className="mt-4 text-white/40 text-sm hover:text-white/60 transition-colors">
              ← Edit my original query
            </button>
          </motion.div>
        )}

        {!clarifying && (
          <p className="mt-6 text-white/50 text-sm italic">
            "I want a 5-star hotel in Paris near the Eiffel Tower with a balcony and free breakfast for 2 people."
          </p>
        )}
      </motion.div>
    </div>
  );
};

const HotelCard = ({ hotel }: { hotel: Hotel; key?: string }) => {
  const [isSaving, setIsSaving] = useState(false);
  const [displayImage, setDisplayImage] = useState(hotel.image || "");
  const [isFindingBetterImage, setIsFindingBetterImage] = useState(false);
  const hasSearched = React.useRef(false);
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [cardSearchParams] = useSearchParams();

  const getFallbackUrl = (h: Hotel) => {
    const query = encodeURIComponent(`${h.name} ${h.address?.cityName || ''} hotel`);
    return `https://images.unsplash.com/photo-1566073771259-6a8506099945?auto=format&fit=crop&q=80&w=1000&q=${query}`;
  };

  useEffect(() => {
    // Rely on server-side enrichment for images. 
    // If image is missing, the server already provides a fallback.
  }, [hotel.name, hotel.image, hotel.address?.cityName]);

  const handleBook = (e: React.MouseEvent) => {
    e.stopPropagation();
    const checkIn = cardSearchParams.get('checkIn') || undefined;
    const checkOut = cardSearchParams.get('checkOut') || undefined;
    const adults = cardSearchParams.get('adults') || '2';
    window.open(buildBookingUrl(hotel, checkIn, checkOut, adults), '_blank', 'noopener,noreferrer');
  };

  const handleSave = async () => {
    if (!user) {
      toast.error("Please sign in to save hotels.");
      return;
    }
    setIsSaving(true);
    try {
      const { doc, setDoc, serverTimestamp } = await import('firebase/firestore');
      await setDoc(doc(db, 'users', user.uid, 'savedHotels', hotel.hotelId), {
        userId: user.uid,
        hotelId: hotel.hotelId,
        hotelName: hotel.name,
        hotelData: hotel,
        checkIn: cardSearchParams.get('checkIn') || null,
        checkOut: cardSearchParams.get('checkOut') || null,
        savedAt: serverTimestamp(),
      });
      toast.success(`${hotel.name} saved to your profile!`);
    } catch (err) {
      toast.error("Failed to save hotel.");
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <motion.div
      layout
      initial={{ opacity: 0, scale: 0.9 }}
      animate={{ opacity: 1, scale: 1 }}
      onClick={() => navigate(`/hotel/${hotel.hotelId}`, { state: { hotel, from: location.search } })}
      className="bg-white/5 border border-white/10 rounded-2xl overflow-hidden group hover:border-white/30 transition-all cursor-pointer flex flex-col"
    >
      <div className="relative h-64 overflow-hidden bg-white/5">
        <img 
          src={displayImage || getFallbackUrl(hotel)} 
          className={`w-full h-full object-cover group-hover:scale-110 transition-transform duration-700 ${isFindingBetterImage ? 'blur-sm grayscale opacity-50' : 'opacity-100'}`}
          alt={hotel.name}
          referrerPolicy="no-referrer"
          onError={(e) => {
            const target = e.target as HTMLImageElement;
            const fallback = getFallbackUrl(hotel);
            if (target.src !== fallback) {
              target.src = fallback;
              setDisplayImage(fallback);
            }
          }}
        />
        {isFindingBetterImage && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/20 backdrop-blur-[2px]">
            <div className="bg-black/60 px-4 py-2 rounded-full flex items-center gap-2">
              <Loader2 className="w-4 h-4 text-white animate-spin" />
              <span className="text-[10px] text-white font-bold uppercase tracking-widest">Finding actual photo...</span>
            </div>
          </div>
        )}
        <div className="absolute top-4 right-4">
          <button
            onClick={(e) => { e.stopPropagation(); handleSave(); }}
            disabled={isSaving}
            className="p-2 bg-black/50 backdrop-blur-md rounded-full text-white hover:text-red-500 transition-colors disabled:opacity-50"
          >
            {isSaving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Heart className="w-5 h-5" />}
          </button>
        </div>
        <div className="absolute top-4 left-4 flex flex-col gap-1.5">
          {Boolean(hotel.starRating && hotel.starRating > 0) && (
            <div className="bg-black/50 backdrop-blur-md px-3 py-1 rounded-full flex items-center gap-1 text-xs font-bold text-white w-fit">
              <Star className="w-3 h-3 text-yellow-500 fill-yellow-500" />
              {hotel.starRating}-star
            </div>
          )}
          {Boolean(hotel.reviewWord || (hotel.avgRating && hotel.avgRating > 0)) && (
            <div className="flex gap-1.5">
              {Boolean(hotel.reviewWord) && (
                <div className="bg-orange-500/90 backdrop-blur-md px-3 py-1 rounded-full text-[11px] font-bold uppercase tracking-tight text-white w-fit shadow-sm">
                  {hotel.reviewWord}
                </div>
              )}
              {Boolean(hotel.avgRating && hotel.avgRating > 0) && (
                <div className="bg-blue-600/90 backdrop-blur-md px-3 py-1 rounded-full text-[11px] font-bold text-white w-fit shadow-sm">
                  {hotel.avgRating!.toFixed(1)} / 10
                </div>
              )}
            </div>
          )}
          {Boolean(hotel.vfmScore && hotel.vfmScore > 0) && (
            <div className={`${hotel.vfmScore! >= 7.5 ? 'bg-emerald-500/95' : 'bg-gray-500/90'} backdrop-blur-md px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-tight text-white w-fit flex items-center gap-1 shadow-md border border-white/20`}>
              <Sparkles className="w-3 h-3" />
              {hotel.vfmScore! >= 7.5 ? 'Great Value' : 'Value'}: {hotel.vfmScore!.toFixed(1)}
            </div>
          )}
          {Boolean(hotel.locationScore && hotel.locationScore > 0) && (
            <div className={`${hotel.locationScore! >= 8 ? 'bg-sky-500/95' : 'bg-gray-500/90'} backdrop-blur-md px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-tight text-white w-fit flex items-center gap-1 shadow-md border border-white/20`}>
              <MapPin className="w-3 h-3" />
              {hotel.locationScore! >= 9 ? 'Prime Location' : hotel.locationScore! >= 8 ? 'Great Location' : 'Location'}: {hotel.locationScore!.toFixed(1)}
            </div>
          )}
          {Boolean(hotel.cleanlinessScore && hotel.cleanlinessScore > 0) && (
            <div className={`${hotel.cleanlinessScore! >= 9 ? 'bg-teal-500/95' : hotel.cleanlinessScore! >= 8 ? 'bg-teal-500/90' : 'bg-gray-500/90'} backdrop-blur-md px-2.5 py-1 rounded-full text-[11px] font-bold uppercase tracking-tight text-white w-fit flex items-center gap-1 shadow-md border border-white/20`}>
              <Check className="w-3 h-3" />
              {hotel.cleanlinessScore! >= 9 ? 'Spotless' : hotel.cleanlinessScore! >= 8 ? 'Very Clean' : 'Clean'}: {hotel.cleanlinessScore!.toFixed(1)}
            </div>
          )}
        </div>
      </div>

      <div className="p-6 flex flex-col flex-1">
        <div className="flex justify-between items-start mb-2">
          <h3 className="text-xl font-bold text-white leading-tight">{hotel.name}</h3>
          <div className="text-right">
            <p className="text-2xl font-light text-white">
              <span className="text-sm text-white/40 font-normal">est. </span>${hotel.price?.total || '---'}
            </p>
            <p className="text-[10px] uppercase tracking-widest text-white/40 font-bold">Est. Per Night</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-2 gap-y-2 text-white/60 text-[10px] mb-6">
          <div className="flex items-center gap-1 whitespace-nowrap">
            <MapPin className="w-3 h-3" />
            {hotel.address?.cityName || 'Unknown'}
          </div>
          {Boolean(hotel.reviews && hotel.reviews > 0) && (
            <div className="flex items-center gap-1 whitespace-nowrap">
              <Sparkles className="w-3 h-3 text-orange-400" />
              {hotel.reviews.toLocaleString()} reviews
            </div>
          )}
          {hotel.breakfast && (
            <div className="flex items-center gap-1 text-green-400 whitespace-nowrap">
              <Coffee className="w-3 h-3" />
              Breakfast
            </div>
          )}
          {hotel.pool && (
            <div className="flex items-center gap-1 text-blue-400 whitespace-nowrap">
              <Waves className="w-3 h-3" />
              Pool
            </div>
          )}
          {hotel.gym && (
            <div className="flex items-center gap-1 text-purple-400 whitespace-nowrap">
              <Dumbbell className="w-3 h-3" />
              Gym
            </div>
          )}
          {hotel.wifi && (
            <div className="flex items-center gap-1 text-sky-400 whitespace-nowrap">
              <Wifi className="w-3 h-3" />
              Free WiFi
            </div>
          )}
          {hotel.freeCancellation && (
            <div className="flex items-center gap-1 text-emerald-400 whitespace-nowrap">
              <Check className="w-3 h-3" />
              Free Cancellation
            </div>
          )}
          {hotel.adults && (
            <div className="flex items-center gap-1 text-white/60 whitespace-nowrap">
              <UserIcon className="w-3 h-3" />
              Sleeps {hotel.adults}
            </div>
          )}
        </div>

        <button
          onClick={handleBook}
          className="mt-auto w-full bg-white text-black py-3 rounded-xl font-bold flex items-center justify-center gap-2 hover:bg-orange-500 hover:text-white transition-all"
        >
          <CreditCard className="w-5 h-5" />
          Book Now
        </button>
      </div>
    </motion.div>
  );
};

// --- Hotel Detail Types ---
interface HotelDetails {
  description: string;
  photos: string[];
  facilities: { name: string }[];
  reviewBreakdown: { category: string; score: number }[];
  checkInTime: string;
  checkOutTime: string;
}

const HotelDetailPage = () => {
  const { hotelId } = useParams<{ hotelId: string }>();
  const location = useLocation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { user } = useAuth();
  const detailCheckIn = location.state?.checkIn || searchParams.get('checkIn') || undefined;
  const detailCheckOut = location.state?.checkOut || searchParams.get('checkOut') || undefined;
  const detailAdults = location.state?.adults || searchParams.get('adults') || '2';

  const hotel: Hotel | undefined = location.state?.hotel;
  const fromSearch: string = location.state?.from || '';

  const [details, setDetails] = useState<HotelDetails | null>(null);
  const [loadingDetails, setLoadingDetails] = useState(true);
  const [activePhoto, setActivePhoto] = useState(0);
  const [lightboxOpen, setLightboxOpen] = useState(false);
  const [isSaving, setIsSaving] = useState(false);

  const allPhotos = details?.photos?.length
    ? details.photos
    : hotel?.image
    ? [hotel.image]
    : [];

  useEffect(() => {
    if (!hotelId) return;
    setLoadingDetails(true);
    fetch(`/api/hotels/${hotelId}/details`)
      .then(r => r.json())
      .then((d: HotelDetails) => setDetails(d))
      .catch(() => setDetails(null))
      .finally(() => setLoadingDetails(false));
  }, [hotelId]);

  const handleSave = async () => {
    if (!user || !hotel) { toast.error("Please sign in to save hotels."); return; }
    setIsSaving(true);
    try {
      const { doc, setDoc, serverTimestamp } = await import('firebase/firestore');
      await setDoc(doc(db, 'users', user.uid, 'savedHotels', hotel.hotelId), {
        userId: user.uid,
        hotelId: hotel.hotelId,
        hotelName: hotel.name,
        hotelData: hotel,
        savedAt: serverTimestamp(),
      });
      toast.success(`${hotel.name} saved!`);
    } catch { toast.error("Failed to save hotel."); }
    finally { setIsSaving(false); }
  };

  if (!hotel) {
    return (
      <div className="pt-40 text-center text-white/60">
        <p className="text-xl mb-4">Hotel not found.</p>
        <button onClick={() => navigate(-1)} className="text-orange-500 hover:underline flex items-center gap-1 mx-auto">
          <ChevronLeft className="w-4 h-4" /> Go Back
        </button>
      </div>
    );
  }

  const facilityIconMap: Record<string, React.ReactNode> = {
    wifi: <Wifi className="w-4 h-4" />,
    internet: <Wifi className="w-4 h-4" />,
    pool: <Waves className="w-4 h-4" />,
    gym: <Dumbbell className="w-4 h-4" />,
    fitness: <Dumbbell className="w-4 h-4" />,
    breakfast: <Coffee className="w-4 h-4" />,
    parking: <Car className="w-4 h-4" />,
  };

  const getFacilityIcon = (name: string) => {
    const lower = name.toLowerCase();
    for (const [key, icon] of Object.entries(facilityIconMap)) {
      if (lower.includes(key)) return icon;
    }
    return <Check className="w-4 h-4" />;
  };

  return (
    <div className="min-h-screen bg-black text-white">
      {/* Back button */}
      <div className="fixed top-20 left-6 z-40">
        <button
          onClick={() => navigate(`/search${fromSearch}`)}
          className="flex items-center gap-2 bg-black/60 backdrop-blur-md px-4 py-2 rounded-full text-sm font-medium text-white/80 hover:text-white border border-white/10 hover:border-white/30 transition-all"
        >
          <ChevronLeft className="w-4 h-4" /> Back to results
        </button>
      </div>

      {/* Photo Gallery */}
      <div className="relative w-full h-[70vh] bg-black overflow-hidden">
        <AnimatePresence mode="wait">
          {allPhotos.length > 0 ? (
            <motion.img
              key={activePhoto}
              src={allPhotos[activePhoto]}
              alt={hotel.name}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.4 }}
              className="w-full h-full object-cover cursor-zoom-in"
              onClick={() => setLightboxOpen(true)}
              referrerPolicy="no-referrer"
              onError={(e) => {
                const t = e.target as HTMLImageElement;
                t.src = `https://images.unsplash.com/photo-1566073771259-6a8506099945?auto=format&fit=crop&q=80&w=1280`;
              }}
            />
          ) : (
            <div className="w-full h-full bg-white/5 animate-pulse" />
          )}
        </AnimatePresence>

        {/* Gradient overlay */}
        <div className="absolute inset-0 bg-gradient-to-t from-black via-black/20 to-transparent pointer-events-none" />

        {/* Nav arrows */}
        {allPhotos.length > 1 && (
          <>
            <button
              onClick={() => setActivePhoto(p => (p - 1 + allPhotos.length) % allPhotos.length)}
              className="absolute left-4 top-1/2 -translate-y-1/2 p-3 bg-black/60 rounded-full hover:bg-black/80 transition-colors"
            >
              <ChevronLeft className="w-6 h-6" />
            </button>
            <button
              onClick={() => setActivePhoto(p => (p + 1) % allPhotos.length)}
              className="absolute right-4 top-1/2 -translate-y-1/2 p-3 bg-black/60 rounded-full hover:bg-black/80 transition-colors"
            >
              <ChevronRight className="w-6 h-6" />
            </button>
            <div className="absolute bottom-6 left-1/2 -translate-x-1/2 text-white/60 text-xs font-medium bg-black/50 px-3 py-1 rounded-full">
              {activePhoto + 1} / {allPhotos.length}
            </div>
          </>
        )}

        {/* Hotel name overlay */}
        <div className="absolute bottom-12 left-8 right-8">
          <div className="flex flex-wrap items-center gap-2 mb-3">
            {hotel.starRating && hotel.starRating > 0 && (
              <div className="bg-black/60 backdrop-blur-sm px-3 py-1 rounded-full flex items-center gap-1 text-xs font-bold text-white">
                <Star className="w-3 h-3 text-yellow-400 fill-yellow-400" />
                {hotel.starRating}-star
              </div>
            )}
            {hotel.reviewWord && (
              <div className="bg-orange-500/90 px-3 py-1 rounded-full text-xs font-bold uppercase text-white">
                {hotel.reviewWord}
              </div>
            )}
            {hotel.avgRating && hotel.avgRating > 0 && (
              <div className="bg-blue-600/90 px-3 py-1 rounded-full text-xs font-bold text-white">
                {hotel.avgRating.toFixed(1)} / 10
              </div>
            )}
            {hotel.vfmScore && hotel.vfmScore >= 7.5 && (
              <div className="bg-emerald-500/90 px-3 py-1 rounded-full text-xs font-bold text-white flex items-center gap-1">
                <Sparkles className="w-3 h-3" /> Great Value
              </div>
            )}
          </div>
          <h1 className="text-4xl md:text-5xl font-bold text-white drop-shadow-lg">{hotel.name}</h1>
          <div className="flex items-center gap-2 mt-2 text-white/70">
            <MapPin className="w-4 h-4" />
            <span>{hotel.address?.cityName}</span>
            {hotel.reviews && hotel.reviews > 0 && (
              <span className="ml-2 text-white/50">· {hotel.reviews.toLocaleString()} reviews</span>
            )}
          </div>
        </div>
      </div>

      {/* Thumbnail strip */}
      {allPhotos.length > 1 && (
        <div className="flex gap-2 px-6 py-3 overflow-x-auto bg-black/80 border-b border-white/10">
          {allPhotos.slice(0, 20).map((photo, i) => (
            <button
              key={i}
              onClick={() => setActivePhoto(i)}
              className={`flex-shrink-0 w-20 h-14 rounded-lg overflow-hidden border-2 transition-all ${activePhoto === i ? 'border-orange-500' : 'border-transparent opacity-60 hover:opacity-100'}`}
            >
              <img src={photo} alt="" className="w-full h-full object-cover" referrerPolicy="no-referrer" />
            </button>
          ))}
        </div>
      )}

      {/* Main content */}
      <div className="max-w-7xl mx-auto px-6 py-12 grid grid-cols-1 lg:grid-cols-3 gap-12">
        {/* Left column */}
        <div className="lg:col-span-2 space-y-10">
          {/* Description */}
          <section>
            <h2 className="text-2xl font-bold mb-4">About this hotel</h2>
            {loadingDetails ? (
              <div className="space-y-3">
                {[...Array(4)].map((_, i) => (
                  <div key={i} className={`h-4 bg-white/10 rounded animate-pulse ${i === 3 ? 'w-2/3' : 'w-full'}`} />
                ))}
              </div>
            ) : details?.description ? (
              <p className="text-white/70 leading-relaxed">{details.description}</p>
            ) : (
              <p className="text-white/40 italic">No description available.</p>
            )}
          </section>

          {/* Amenities highlight */}
          <section>
            <h2 className="text-2xl font-bold mb-4">Amenities</h2>
            <div className="flex flex-wrap gap-3">
              {hotel.breakfast && (
                <div className="flex items-center gap-2 bg-white/5 border border-white/10 px-4 py-2 rounded-xl text-sm text-green-400">
                  <Coffee className="w-4 h-4" /> Free Breakfast
                </div>
              )}
              {hotel.pool && (
                <div className="flex items-center gap-2 bg-white/5 border border-white/10 px-4 py-2 rounded-xl text-sm text-blue-400">
                  <Waves className="w-4 h-4" /> Swimming Pool
                </div>
              )}
              {hotel.gym && (
                <div className="flex items-center gap-2 bg-white/5 border border-white/10 px-4 py-2 rounded-xl text-sm text-purple-400">
                  <Dumbbell className="w-4 h-4" /> Gym / Fitness
                </div>
              )}
              {hotel.wifi && (
                <div className="flex items-center gap-2 bg-white/5 border border-white/10 px-4 py-2 rounded-xl text-sm text-sky-400">
                  <Wifi className="w-4 h-4" /> Free WiFi
                </div>
              )}
              {hotel.freeCancellation && (
                <div className="flex items-center gap-2 bg-white/5 border border-white/10 px-4 py-2 rounded-xl text-sm text-emerald-400">
                  <Check className="w-4 h-4" /> Free Cancellation
                </div>
              )}
            </div>
          </section>

          {/* Full facilities grid */}
          {details?.facilities && details.facilities.length > 0 && (
            <section>
              <h2 className="text-2xl font-bold mb-4">Facilities</h2>
              {loadingDetails ? (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  {[...Array(12)].map((_, i) => (
                    <div key={i} className="h-10 bg-white/10 rounded-lg animate-pulse" />
                  ))}
                </div>
              ) : (
                <div className="grid grid-cols-2 md:grid-cols-3 gap-2">
                  {details.facilities.map((f, i) => (
                    <div key={i} className="flex items-center gap-2 bg-white/5 border border-white/10 px-3 py-2 rounded-lg text-sm text-white/70">
                      <span className="text-orange-400">{getFacilityIcon(f.name)}</span>
                      {f.name}
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* Review breakdown */}
          {details?.reviewBreakdown && details.reviewBreakdown.length > 0 && (
            <section>
              <h2 className="text-2xl font-bold mb-4">Review Scores</h2>
              <div className="space-y-3">
                {details.reviewBreakdown.map((item, i) => (
                  <div key={i}>
                    <div className="flex justify-between text-sm mb-1">
                      <span className="text-white/70 capitalize">{item.category}</span>
                      <span className="font-bold text-white">{item.score.toFixed(1)}</span>
                    </div>
                    <div className="h-2 bg-white/10 rounded-full overflow-hidden">
                      <motion.div
                        initial={{ width: 0 }}
                        animate={{ width: `${(item.score / 10) * 100}%` }}
                        transition={{ duration: 0.8, delay: i * 0.1 }}
                        className="h-full bg-orange-500 rounded-full"
                      />
                    </div>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Check-in/out policy */}
          {(details?.checkInTime || details?.checkOutTime) && (
            <section>
              <h2 className="text-2xl font-bold mb-4">Policies</h2>
              <div className="flex gap-6 flex-wrap">
                {details.checkInTime && (
                  <div className="bg-white/5 border border-white/10 rounded-xl px-6 py-4">
                    <p className="text-xs uppercase tracking-widest text-white/40 mb-1">Check-in</p>
                    <p className="text-xl font-bold">{details.checkInTime}</p>
                  </div>
                )}
                {details.checkOutTime && (
                  <div className="bg-white/5 border border-white/10 rounded-xl px-6 py-4">
                    <p className="text-xs uppercase tracking-widest text-white/40 mb-1">Check-out</p>
                    <p className="text-xl font-bold">{details.checkOutTime}</p>
                  </div>
                )}
              </div>
            </section>
          )}
        </div>

        {/* Sticky booking sidebar */}
        <div className="lg:col-span-1">
          <div className="sticky top-28 bg-white/5 border border-white/10 rounded-2xl p-6 space-y-4">
            <div className="flex justify-between items-end">
              <div>
                <p className="text-4xl font-light text-white">
                  {hotel.price?.currency === 'USD' ? '$' : ''}{hotel.price?.total || '---'}
                </p>
                <p className="text-xs uppercase tracking-widest text-white/40 font-bold mt-1">per night</p>
              </div>
              {hotel.vfmScore && hotel.vfmScore > 0 && (
                <div className={`${hotel.vfmScore >= 7.5 ? 'bg-emerald-500/20 text-emerald-400' : 'bg-white/5 text-white/40'} px-3 py-1.5 rounded-full text-xs font-bold flex items-center gap-1`}>
                  <Sparkles className="w-3 h-3" />
                  VFM {hotel.vfmScore.toFixed(1)}
                </div>
              )}
            </div>

            {hotel.avgRating && hotel.avgRating > 0 && (
              <div className="flex items-center gap-2 text-sm text-white/60 border-t border-white/10 pt-4">
                <div className="bg-blue-600 text-white font-bold px-2 py-0.5 rounded text-xs">
                  {hotel.avgRating.toFixed(1)}
                </div>
                <span>{hotel.reviewWord || 'Rated'}</span>
                {hotel.reviews && <span className="text-white/30">· {hotel.reviews.toLocaleString()} reviews</span>}
              </div>
            )}

            <a
              href={buildBookingUrl(hotel, detailCheckIn, detailCheckOut, detailAdults)}
              target="_blank"
              rel="noopener noreferrer"
              className="block w-full bg-orange-500 hover:bg-orange-400 text-white py-4 rounded-xl font-bold text-center transition-colors"
            >
              Reserve on Booking.com
            </a>

            <button
              onClick={handleSave}
              disabled={isSaving}
              className="w-full border border-white/20 hover:border-white/40 text-white py-3 rounded-xl font-medium flex items-center justify-center gap-2 transition-colors disabled:opacity-50"
            >
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Heart className="w-4 h-4" />}
              Save to Wishlist
            </button>

            <div className="flex flex-wrap gap-2 pt-2 border-t border-white/10">
              {hotel.breakfast && <span className="text-xs text-green-400 flex items-center gap-1"><Coffee className="w-3 h-3" />Breakfast</span>}
              {hotel.pool && <span className="text-xs text-blue-400 flex items-center gap-1"><Waves className="w-3 h-3" />Pool</span>}
              {hotel.gym && <span className="text-xs text-purple-400 flex items-center gap-1"><Dumbbell className="w-3 h-3" />Gym</span>}
            </div>
          </div>
        </div>
      </div>

      {/* Lightbox */}
      <AnimatePresence>
        {lightboxOpen && allPhotos.length > 0 && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-black/95 flex items-center justify-center"
            onClick={() => setLightboxOpen(false)}
          >
            <button className="absolute top-6 right-6 p-2 text-white/60 hover:text-white">
              <X className="w-8 h-8" />
            </button>
            <button
              className="absolute left-6 top-1/2 -translate-y-1/2 p-3 bg-white/10 rounded-full hover:bg-white/20"
              onClick={(e) => { e.stopPropagation(); setActivePhoto(p => (p - 1 + allPhotos.length) % allPhotos.length); }}
            >
              <ChevronLeft className="w-8 h-8" />
            </button>
            <img
              src={allPhotos[activePhoto]}
              alt=""
              className="max-h-[85vh] max-w-[85vw] object-contain rounded-xl"
              referrerPolicy="no-referrer"
              onClick={e => e.stopPropagation()}
            />
            <button
              className="absolute right-6 top-1/2 -translate-y-1/2 p-3 bg-white/10 rounded-full hover:bg-white/20"
              onClick={(e) => { e.stopPropagation(); setActivePhoto(p => (p + 1) % allPhotos.length); }}
            >
              <ChevronRight className="w-8 h-8" />
            </button>
            <div className="absolute bottom-6 text-white/40 text-sm">
              {activePhoto + 1} / {allPhotos.length}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

type SortOption = 'price_asc' | 'price_desc' | 'rating' | 'reviews' | 'value' | 'location' | 'cleanliness';

const SORT_OPTIONS: { value: SortOption; label: string }[] = [
  { value: 'price_asc',   label: 'Price: Low → High' },
  { value: 'price_desc',  label: 'Price: High → Low' },
  { value: 'rating',      label: 'Review Score' },
  { value: 'reviews',     label: 'Most Reviews' },
  { value: 'value',       label: 'Value Score' },
  { value: 'location',    label: 'Location' },
  { value: 'cleanliness', label: 'Cleanliness' },
];

type FilterOption = 'breakfast' | 'pool' | 'gym' | 'wifi' | 'freeCancellation';

const FILTER_OPTIONS: { value: FilterOption; label: string; icon: React.ReactNode; color: string }[] = [
  { value: 'breakfast',       label: 'Breakfast',        icon: <Coffee className="w-3 h-3" />,   color: 'text-green-400' },
  { value: 'pool',            label: 'Pool',             icon: <Waves className="w-3 h-3" />,    color: 'text-blue-400' },
  { value: 'gym',             label: 'Gym',              icon: <Dumbbell className="w-3 h-3" />, color: 'text-purple-400' },
  { value: 'wifi',            label: 'Free WiFi',        icon: <Wifi className="w-3 h-3" />,     color: 'text-sky-400' },
  { value: 'freeCancellation',label: 'Free Cancel',      icon: <Check className="w-3 h-3" />,    color: 'text-emerald-400' },
];


function buildBookingUrl(hotel: Hotel, checkIn?: string, checkOut?: string, adults?: string): string {
  const params = new URLSearchParams({ name: hotel.name || '' });
  if (hotel.countryCode) params.set('cc', hotel.countryCode);
  if (hotel.bookingUrl) params.set('bookingUrl', hotel.bookingUrl);
  if (checkIn) params.set('checkIn', checkIn);
  if (checkOut) params.set('checkOut', checkOut);
  if (adults) params.set('adults', adults);
  return `/api/hotel-redirect?${params.toString()}`;
}

function sortHotels(hotels: Hotel[], sortKeys: SortOption[]): Hotel[] {
  if (!sortKeys.length) return hotels;
  return [...hotels].sort((a, b) => {
    for (const key of sortKeys) {
      let diff = 0;
      switch (key) {
        case 'price_asc':   diff = Number(a.price?.total || 0) - Number(b.price?.total || 0); break;
        case 'price_desc':  diff = Number(b.price?.total || 0) - Number(a.price?.total || 0); break;
        case 'rating':      diff = (b.avgRating || 0) - (a.avgRating || 0); break;
        case 'reviews':     diff = (b.reviews || 0) - (a.reviews || 0); break;
        case 'value':       diff = (b.vfmScore || 0) - (a.vfmScore || 0); break;
        case 'location':    diff = (b.locationScore || 0) - (a.locationScore || 0); break;
        case 'cleanliness': diff = (b.cleanlinessScore || 0) - (a.cleanlinessScore || 0); break;
      }
      if (diff !== 0) return diff;
    }
    return 0;
  });
}

// Module-level cache so back-navigation reuses results without re-fetching
const hotelResultsCache = new Map<string, { hotels: Hotel[]; note: string | null }>();

const SearchResults = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const [hotels, setHotels] = useState<Hotel[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchNote, setSearchNote] = useState<string | null>(null);
  const [recommendation, setRecommendation] = useState<string | null>(null);
  const [loadingRec, setLoadingRec] = useState(false);
  const [refinement, setRefinement] = useState('');
  const [refining, setRefining] = useState(false);
  const [sortKeys, setSortKeysState] = useState<SortOption[]>(() => {
    try { return JSON.parse(sessionStorage.getItem('conciergeai-sort-keys') || '[]'); }
    catch { return []; }
  });
  const setSortKeys = (keys: SortOption[]) => {
    setSortKeysState(keys);
    sessionStorage.setItem('conciergeai-sort-keys', JSON.stringify(keys));
  };

  // Filters are derived from URL params and trigger a new API search (server-side filtering is more accurate)
  const activeFilters: FilterOption[] = FILTER_OPTIONS.map(f => f.value).filter(f => searchParams.get(f) === 'true');
  const toggleFilter = (f: FilterOption) => {
    const next = new URLSearchParams(searchParams.toString());
    if (next.get(f) === 'true') next.delete(f); else next.set(f, 'true');
    navigate(`/search?${next.toString()}`);
  };
  const clearFilters = () => {
    const next = new URLSearchParams(searchParams.toString());
    FILTER_OPTIONS.forEach(f => next.delete(f.value));
    navigate(`/search?${next.toString()}`);
  };
  const city = searchParams.get('city');
  const query = searchParams.get('q');
  const checkIn = searchParams.get('checkIn');
  const checkOut = searchParams.get('checkOut');

  useEffect(() => {
    if (!city) return;
    const controller = new AbortController();
    // eslint-disable-next-line

    const fetchHotels = async () => {
      setLoading(true);
      try {
        const checkIn = searchParams.get('checkIn') || '';
        const checkOut = searchParams.get('checkOut') || '';
        const adults = searchParams.get('adults') || '1';
        const ratings = searchParams.get('ratings') || '';
        const breakfast = searchParams.get('breakfast') || '';
        const pool = searchParams.get('pool') || '';
        const gym = searchParams.get('gym') || '';
        const wifi = searchParams.get('wifi') || '';
        const freeCancellation = searchParams.get('freeCancellation') || '';
        const maxPrice = searchParams.get('maxPrice') || '';
        const minReviewScore = searchParams.get('minReviewScore') || '';
        const highReviewCount = searchParams.get('highReviewCount') || '';

        const neighborhood = searchParams.get('neighborhood') || '';
        const queryParams = new URLSearchParams({ city, q: query || '', checkIn, checkOut, adults });
        if (neighborhood) queryParams.set('neighborhood', neighborhood);
        if (ratings) queryParams.set('ratings', ratings);
        if (breakfast) queryParams.set('breakfast', breakfast);
        if (pool) queryParams.set('pool', pool);
        if (gym) queryParams.set('gym', gym);
        if (wifi) queryParams.set('wifi', wifi);
        if (freeCancellation) queryParams.set('freeCancellation', freeCancellation);
        if (maxPrice) queryParams.set('maxPrice', maxPrice);
        if (minReviewScore) queryParams.set('minReviewScore', minReviewScore);
        if (highReviewCount) queryParams.set('highReviewCount', highReviewCount);

        const cacheKey = queryParams.toString();
        const cached = hotelResultsCache.get(cacheKey);
        if (cached) {
          setHotels(cached.hotels);
          setSearchNote(cached.note);
          setLoading(false);
          return;
        }

        const response = await fetch(`/api/hotels/search?${queryParams.toString()}`, { signal: controller.signal });
        const data = await response.json();

        const note = data.note || null;
        const hotels = data.data || [];
        hotelResultsCache.set(cacheKey, { hotels, note });

        setSearchNote(note);
        setHotels(hotels);

        if (hotels.length > 0 && query) {
          setLoadingRec(true);
          fetch('/api/hotels/recommend', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query, hotels: hotels.slice(0, 5) }),
            signal: controller.signal
          })
            .then(r => r.json())
            .then(d => { if (d.recommendation) setRecommendation(d.recommendation.replace(/\*\*/g, '')); })
            .catch(() => {})
            .finally(() => setLoadingRec(false));
        }
      } catch (err: any) {
        if (err.name !== 'AbortError') toast.error("Failed to fetch hotels.");
      } finally {
        setLoading(false);
      }
    };

    setRecommendation(null);
    fetchHotels();
    return () => controller.abort();
  }, [searchParams.toString()]);

  const handleRefine = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!refinement.trim() || refining) return;
    setRefining(true);
    try {
      const currentParams: Record<string, string> = {
        city: searchParams.get('city') || '',
        neighborhood: searchParams.get('neighborhood') || '',
        adults: searchParams.get('adults') || '1',
        checkInDate: searchParams.get('checkIn') || '',
        checkOutDate: searchParams.get('checkOut') || '',
        ratings: searchParams.get('ratings') || '',
        minReviewScore: searchParams.get('minReviewScore') || '',
        breakfast: searchParams.get('breakfast') || '',
        pool: searchParams.get('pool') || '',
        gym: searchParams.get('gym') || '',
        wifi: searchParams.get('wifi') || '',
        freeCancellation: searchParams.get('freeCancellation') || '',
        maxPrice: searchParams.get('maxPrice') || '',
        sortBy: searchParams.get('sortBy') || '',
      };
      const resp = await fetch('/api/refine-query', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ currentParams, refinement }),
      });
      const updated = await resp.json();
      if (updated.error) { toast.error('Could not refine search.'); return; }

      const params = new URLSearchParams({
        city: updated.city || currentParams.city,
        adults: String(updated.adults || 1),
        checkIn: updated.checkInDate || currentParams.checkInDate,
        checkOut: updated.checkOutDate || currentParams.checkOutDate,
        q: `${query} · ${refinement}`,
      });
      if (updated.neighborhood) params.set('neighborhood', updated.neighborhood);
      const ratingsArr = Array.isArray(updated.ratings) ? updated.ratings : updated.ratings ? [updated.ratings] : [];
      if (ratingsArr.length) params.set('ratings', ratingsArr.join(','));
      if (updated.breakfast) params.set('breakfast', 'true');
      if (updated.pool) params.set('pool', 'true');
      if (updated.gym) params.set('gym', 'true');
      if (updated.wifi) params.set('wifi', 'true');
      if (updated.freeCancellation) params.set('freeCancellation', 'true');
      if (updated.maxPrice) params.set('maxPrice', String(updated.maxPrice));
      if (updated.minReviewScore) params.set('minReviewScore', String(updated.minReviewScore));
      if (updated.sortBy) params.set('sortBy', updated.sortBy);
      setRefinement('');
      navigate(`/search?${params.toString()}`);
    } catch (err: any) {
      console.error('Refinement error:', err);
      toast.error(`Refinement failed: ${err?.message || 'Unknown error'}`);
    } finally {
      setRefining(false);
    }
  };

  return (
    <div className="pt-32 pb-20 px-6 max-w-7xl mx-auto">
      <div className="mb-12 flex flex-col md:flex-row md:items-end justify-between gap-6">
        <div>
          <h2 className="text-4xl font-light text-white mb-2">
            Results for <span className="italic font-serif">"{query}"</span>
          </h2>
          <div className="flex flex-wrap items-center gap-4 text-white/50 uppercase tracking-widest text-xs font-bold">
            <span>{hotels.length} Properties Found in {searchParams.get('neighborhood') ? `${searchParams.get('neighborhood')}, ` : ''}{city}</span>
            {searchParams.get('adults') && (
              <span className="bg-white/10 px-2 py-1 rounded text-white/70">
                {searchParams.get('adults')} Adults
              </span>
            )}
            {checkIn && checkOut && (
              <span className="bg-white/10 px-2 py-1 rounded text-white/70">
                {(() => {
                  const fmt = (s: string) => {
                    const p = s.split('-');
                    return p.length === 3 ? `${Number(p[1])}/${Number(p[2])}/${p[0]}` : s;
                  };
                  return `${fmt(checkIn)} — ${fmt(checkOut)}`;
                })()}
              </span>
            )}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <Link
            to="/"
            state={{ prefill: query }}
            className="flex items-center gap-2 bg-orange-500 hover:bg-orange-400 text-white px-6 py-3 rounded-full text-sm font-bold transition-all"
          >
            <Search className="w-4 h-4" />
            Modify Search
          </Link>
          <Link
            to="/"
            className="flex items-center gap-2 bg-white/10 hover:bg-white/20 text-white px-6 py-3 rounded-full text-sm font-bold transition-all backdrop-blur-md border border-white/10"
          >
            <ArrowLeft className="w-4 h-4" />
            New Search
          </Link>
        </div>
      </div>

      {searchNote && hotels.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-10 p-5 bg-white/5 border border-white/10 rounded-3xl flex items-center gap-4 text-white/80 backdrop-blur-sm"
        >
          <div className="w-10 h-10 rounded-full bg-amber-400/10 flex items-center justify-center shrink-0">
            <Sparkles className="w-5 h-5 text-amber-400" />
          </div>
          <p className="text-sm md:text-base leading-relaxed">{searchNote}</p>
        </motion.div>
      )}

      <form onSubmit={handleRefine} className="mb-8 flex gap-3">
        <input
          type="text"
          value={refinement}
          onChange={e => setRefinement(e.target.value)}
          placeholder='Refine your search… e.g. "Make it cheaper" or "Add a pool" or "Near the beach"'
          className="flex-1 bg-white/5 border border-white/10 rounded-full px-5 py-3 text-white placeholder-white/30 text-sm outline-none focus:border-orange-500/50 transition-all"
        />
        <button
          type="submit"
          disabled={!refinement.trim() || refining}
          className="bg-orange-500 hover:bg-orange-400 disabled:opacity-40 text-white px-6 py-3 rounded-full text-sm font-bold transition-all shrink-0"
        >
          {refining ? 'Refining…' : 'Refine'}
        </button>
      </form>

      {(loadingRec || recommendation) && hotels.length > 0 && (
        <motion.div
          initial={{ opacity: 0, y: -10 }}
          animate={{ opacity: 1, y: 0 }}
          className="mb-8 p-5 bg-orange-500/10 border border-orange-500/20 rounded-3xl flex items-start gap-4 backdrop-blur-sm"
        >
          <div className="w-10 h-10 rounded-full bg-orange-500/20 flex items-center justify-center shrink-0 mt-0.5">
            <Sparkles className="w-5 h-5 text-orange-400" />
          </div>
          <div>
            <p className="text-orange-400 text-xs font-bold uppercase tracking-widest mb-1">ConciergeAI Recommends</p>
            {loadingRec && !recommendation
              ? <p className="text-white/50 text-sm animate-pulse">Analyzing results…</p>
              : <p className="text-white/90 text-sm md:text-base leading-relaxed">{recommendation}</p>
            }
          </div>
        </motion.div>
      )}

      {!loading && hotels.length > 0 && (
        <div className="flex flex-col gap-3 mb-6">
          {/* Filter bar */}
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-white/40 text-xs mr-1">Filter</span>
            {FILTER_OPTIONS.map(f => {
              const active = activeFilters.includes(f.value);
              return (
                <button
                  key={f.value}
                  onClick={() => toggleFilter(f.value)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-bold transition-all border ${
                    active
                      ? 'bg-white text-black border-white'
                      : 'bg-white/5 text-white/50 border-white/10 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  <span className={active ? 'text-black' : f.color}>{f.icon}</span>
                  {f.label}
                </button>
              );
            })}
            {activeFilters.length > 0 && (
              <button onClick={clearFilters} className="text-white/30 hover:text-white/60 text-xs transition-all ml-1">
                Clear filters
              </button>
            )}
          </div>

          {/* Sort bar */}
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-white/40 text-sm mr-1">{hotels.length} results</p>
          {sortKeys.map((key, i) => {
            const available = SORT_OPTIONS.filter(o => !sortKeys.includes(o.value) || o.value === key);
            return (
              <div key={i} className="flex items-center gap-1.5">
                {i === 0
                  ? <span className="text-white/40 text-xs">Sort by</span>
                  : <span className="text-white/30 text-xs">then by</span>
                }
                <select
                  value={key}
                  onChange={e => {
                    const next = [...sortKeys];
                    next[i] = e.target.value as SortOption;
                    setSortKeys(next);
                  }}
                  className="bg-orange-500 text-white text-xs font-bold px-3 py-1.5 rounded-full border-none outline-none cursor-pointer"
                >
                  {available.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
                <button
                  onClick={() => setSortKeys(sortKeys.filter((_, j) => j !== i))}
                  className="text-white/40 hover:text-white text-sm leading-none"
                >×</button>
              </div>
            );
          })}
          {sortKeys.length < SORT_OPTIONS.length && (
            <button
              onClick={() => {
                const next = SORT_OPTIONS.find(o => !sortKeys.includes(o.value));
                if (next) setSortKeys([...sortKeys, next.value]);
              }}
              className="px-3 py-1.5 rounded-full text-xs font-bold bg-white/10 text-white/60 hover:bg-white/20 hover:text-white transition-all"
            >
              {sortKeys.length === 0 ? '+ Sort' : '+ Then by'}
            </button>
          )}
          {sortKeys.length > 0 && (
            <button
              onClick={() => setSortKeys([])}
              className="text-white/30 hover:text-white/60 text-xs transition-all"
            >Clear sort</button>
          )}
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex flex-col items-center justify-center h-64 gap-4">
          <Loader2 className="w-12 h-12 text-white animate-spin" />
          <p className="text-white/50 animate-pulse">Curating the best stays for you...</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-8">
          {sortHotels(hotels, sortKeys).map((hotel) => (
            <HotelCard key={hotel.hotelId} hotel={hotel} />
          ))}
          {hotels.length === 0 && (
            <div className="col-span-full text-center py-20 border border-dashed border-white/10 rounded-3xl">
              <p className="text-white/30 text-xl">No hotels found matching your specific criteria.</p>
              <Link to="/" className="text-white underline mt-4 inline-block">Try another search</Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

const Profile = () => {
  const { profile, user, updateProfile } = useAuth();
  const navigate = useNavigate();
  const [prefs, setPrefs] = useState(profile?.preferences || '');
  const [saving, setSaving] = useState(false);
  const [savedHotels, setSavedHotels] = useState<any[]>([]);
  const [loadingHotels, setLoadingHotels] = useState(true);

  useEffect(() => {
    if (!user) { navigate('/'); return; }
    const loadSaved = async () => {
      try {
        const { collection, getDocs, orderBy, query: fsQuery } = await import('firebase/firestore');
        const snap = await getDocs(fsQuery(collection(db, 'users', user.uid, 'savedHotels'), orderBy('savedAt', 'desc')));
        setSavedHotels(snap.docs.map(d => ({ ...d.data().hotelData, _checkIn: d.data().checkIn, _checkOut: d.data().checkOut })));
      } catch (err) {
        console.error("Failed to load saved hotels:", err);
      } finally {
        setLoadingHotels(false);
      }
    };
    loadSaved();
  }, [user, navigate]);

  const handleSave = async () => {
    if (!user) {
      toast.error("Not signed in — please sign in and try again.");
      return;
    }
    setSaving(true);
    try {
      await updateDoc(doc(db, 'users', user.uid), { preferences: prefs });
      updateProfile({ preferences: prefs });
      toast.success("Preferences saved!");
    } catch (err: any) {
      console.error("Preferences save error:", err?.code, err?.message);
      toast.error("Failed to save preferences. Please try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="pt-32 pb-20 px-6 max-w-3xl mx-auto">
      <h2 className="text-5xl font-light text-white mb-12 tracking-tighter">Your <span className="italic font-serif">Profile</span></h2>
      
      <div className="space-y-8">
        <div className="bg-white/5 border border-white/10 p-8 rounded-3xl">
          <label className="block text-xs uppercase tracking-widest font-bold text-white/40 mb-4">Default Preferences</label>
          <textarea 
            value={prefs}
            onChange={(e) => setPrefs(e.target.value)}
            placeholder="e.g. Always prefer 4+ stars, free breakfast, and central locations."
            className="w-full bg-black/20 border border-white/10 rounded-2xl p-6 text-white focus:outline-none focus:border-white/30 h-40 resize-none"
          />
          <button 
            onClick={handleSave}
            disabled={saving}
            className="mt-6 bg-white text-black px-8 py-3 rounded-full font-bold hover:bg-orange-500 hover:text-white transition-all disabled:opacity-50 flex items-center gap-2"
          >
            {saving && <Loader2 className="w-4 h-4 animate-spin" />}
            Save Preferences
          </button>
        </div>

        <div className="bg-white/5 border border-white/10 p-8 rounded-3xl">
          <label className="block text-xs uppercase tracking-widest font-bold text-white/40 mb-6">Saved Hotels</label>
          {loadingHotels ? (
            <div className="flex items-center gap-2 text-white/40"><Loader2 className="w-4 h-4 animate-spin" /> Loading...</div>
          ) : savedHotels.length === 0 ? (
            <p className="text-white/40">No saved hotels yet. Click the heart icon on any hotel to save it.</p>
          ) : (
            <div className="space-y-4">
              {savedHotels.map((hotel: any) => (
                <Link key={hotel.hotelId} to={`/hotel/${hotel.hotelId}`} state={{ hotel }} className="flex items-center gap-4 bg-white/5 rounded-2xl p-4 hover:bg-white/10 transition-colors">
                  <img src={hotel.image} alt={hotel.name} className="w-20 h-16 object-cover rounded-xl flex-shrink-0" referrerPolicy="no-referrer" />
                  <div className="flex-1 min-w-0">
                    <p className="text-white font-semibold truncate">{hotel.name}</p>
                    <p className="text-white/40 text-sm">{hotel.address?.cityName} · {hotel.starRating > 0 ? `${hotel.starRating}★` : ''} {hotel.avgRating > 0 ? `${hotel.avgRating}/10` : ''}</p>
                  </div>
                  <div className="text-right flex-shrink-0">
                    <p className="text-white font-bold">${hotel.price?.total || '—'}<span className="text-white/40 text-xs font-normal">/night</span></p>
                    {hotel._checkIn && hotel._checkOut && <p className="text-white/40 text-xs">{hotel._checkIn} – {hotel._checkOut}</p>}
                  </div>
                </Link>
              ))}
            </div>
          )}
        </div>

        <div className="bg-white/5 border border-white/10 p-8 rounded-3xl">
          <label className="block text-xs uppercase tracking-widest font-bold text-white/40 mb-4">Account Details</label>
          <div className="space-y-4">
            <div>
              <p className="text-white/40 text-xs">Email</p>
              <p className="text-white text-lg">{profile?.email}</p>
            </div>
            <div>
              <p className="text-white/40 text-xs">Name</p>
              <p className="text-white text-lg">{profile?.displayName}</p>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

// --- Evals Page ---
import { searchTestCases, TestCase } from './lib/evals';

const EvalsPage = () => {
  const [results, setResults] = useState<any[]>([]);
  const [isRunning, setIsRunning] = useState(false);

  const runEvals = async () => {
    setIsRunning(true);
    setResults([]);
    
    const evalPromises = searchTestCases.map(async (test) => {
      try {
        const parsed = await parseTravelQuery(test.query);
        const failedKeys: string[] = [];
        const status = Object.keys(test.expected).every(key => {
          const expectedVal = (test.expected as any)[key];
          const actualVal = (parsed as any)[key];
          
          let match = false;
          if (Array.isArray(expectedVal)) {
            match = JSON.stringify(expectedVal) === JSON.stringify(actualVal);
          } else {
            match = expectedVal === actualVal;
          }

          if (!match) failedKeys.push(key);
          return match;
        });

        return { test, parsed, status, failedKeys };
      } catch (err) {
        return { test, parsed: null, status: false, error: true, failedKeys: [] };
      }
    });

    const allResults = await Promise.all(evalPromises);
    setResults(allResults);
    setIsRunning(false);
  };

  return (
    <div className="pt-32 pb-20 px-6 max-w-5xl mx-auto">
      <div className="flex justify-between items-center mb-12">
        <h2 className="text-5xl font-light text-white tracking-tighter">AI <span className="italic font-serif">Evals</span></h2>
        <button 
          onClick={runEvals}
          disabled={isRunning}
          className="bg-orange-500 text-white px-8 py-3 rounded-full font-bold hover:bg-orange-600 transition-all disabled:opacity-50 flex items-center gap-2"
        >
          {isRunning ? <Loader2 className="w-5 h-5 animate-spin" /> : <Sparkles className="w-5 h-5" />}
          Run All Tests
        </button>
      </div>

      <div className="space-y-4">
        {results.map((res, i) => (
          <div key={i} className={`p-6 rounded-2xl border ${res.status ? 'bg-green-500/10 border-green-500/30' : 'bg-red-500/10 border-red-500/30'}`}>
            <div className="flex justify-between items-start mb-4">
              <div>
                <h4 className="font-bold text-white">{res.test.name}</h4>
                <p className="text-sm text-white/50 italic">"{res.test.query}"</p>
                {res.failedKeys && res.failedKeys.length > 0 && (
                  <p className="text-xs text-red-400 mt-1 font-bold uppercase tracking-widest">
                    Failed Keys: {res.failedKeys.join(', ')}
                  </p>
                )}
              </div>
              <span className={`px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest ${res.status ? 'bg-green-500 text-white' : 'bg-red-500 text-white'}`}>
                {res.status ? 'Passed' : 'Failed'}
              </span>
            </div>
            
            <div className="grid grid-cols-2 gap-4 text-xs">
              <div className="bg-black/20 p-4 rounded-xl">
                <p className="text-white/30 mb-2 uppercase font-bold">Expected</p>
                <pre className="text-white font-mono">{JSON.stringify(res.test.expected, null, 2)}</pre>
              </div>
              <div className="bg-black/20 p-4 rounded-xl">
                <p className="text-white/30 mb-2 uppercase font-bold">Actual (AI Parsed)</p>
                <pre className="text-white font-mono">{JSON.stringify(res.parsed, null, 2)}</pre>
              </div>
            </div>
          </div>
        ))}
        {!isRunning && results.length === 0 && (
          <div className="text-center py-20 border border-dashed border-white/10 rounded-3xl text-white/30">
            Click "Run All Tests" to begin evaluation.
          </div>
        )}
      </div>
    </div>
  );
};

// --- Main App ---

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const testConnection = async () => {
      try {
        const { getDocFromServer, doc: fDoc } = await import('firebase/firestore');
        await getDocFromServer(fDoc(db, 'test', 'connection'));
      } catch (error) {
        if (error instanceof Error && error.message.includes('the client is offline')) {
          console.error("Please check your Firebase configuration.");
        }
      }
    };
    testConnection();

    const unsubscribe = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        const docRef = doc(db, 'users', u.uid);
        try {
          const docSnap = await getDoc(docRef);
          if (docSnap.exists()) {
            setProfile(docSnap.data() as UserProfile);
          } else {
            const newProfile = {
              uid: u.uid,
              email: u.email || '',
              displayName: u.displayName || 'Traveler',
              createdAt: serverTimestamp(),
            };
            await setDoc(docRef, newProfile);
            setProfile(newProfile as UserProfile);
          }
        } catch (err) {
          handleFirestoreError(err, OperationType.GET, `users/${u.uid}`);
        }
      } else {
        setProfile(null);
      }
      setLoading(false);
    });
    return unsubscribe;
  }, []);

  const signIn = async () => {
    const provider = new GoogleAuthProvider();
    try {
      await signInWithPopup(auth, provider);
    } catch (err: any) {
      console.error("Sign in error:", err?.code, err?.message);
      toast.error("Sign in failed. Please try again.");
    }
  };

  const logout = async () => {
    await signOut(auth);
    toast.success("Logged out.");
  };

  const updateProfile = (updates: Partial<UserProfile>) => {
    setProfile(prev => prev ? { ...prev, ...updates } : prev);
  };

  return (
    <AuthContext.Provider value={{ user, profile, loading, signIn, logout, updateProfile }}>
      <Router>
        <div className="min-h-screen bg-black text-white font-sans selection:bg-orange-500 selection:text-white">
          <Toaster position="top-center" theme="dark" />
          <Navbar />
          
          <main>
            <Routes>
              <Route path="/" element={<Hero />} />
              <Route path="/search" element={<SearchResults />} />
              <Route path="/hotel/:hotelId" element={<HotelDetailPage />} />
              <Route path="/profile" element={<Profile />} />
              <Route path="/evals" element={<EvalsPage />} />
              <Route path="/success" element={
                <div className="pt-40 text-center">
                  <h2 className="text-6xl font-bold mb-4">Success!</h2>
                  <p className="text-white/60">Your booking has been confirmed. Check your email for details.</p>
                  <Link to="/" className="mt-8 inline-block text-white underline">Back Home</Link>
                </div>
              } />
              <Route path="/cancel" element={
                <div className="pt-40 text-center">
                  <h2 className="text-6xl font-bold mb-4">Cancelled</h2>
                  <p className="text-white/60">Your payment was not processed.</p>
                  <Link to="/" className="mt-8 inline-block text-white underline">Back Home</Link>
                </div>
              } />
            </Routes>
          </main>

          <footer className="border-t border-white/10 py-12 px-6 mt-20">
            <div className="max-w-7xl mx-auto flex flex-col md:flex-row justify-between items-center gap-8">
              <div className="text-xl font-light tracking-tighter text-white/50">
                CONCIERGE<span className="font-bold">AI</span>
              </div>
              <div className="flex gap-8 text-sm text-white/30 font-medium uppercase tracking-widest">
                <a href="#" className="hover:text-white transition-colors">Privacy</a>
                <a href="#" className="hover:text-white transition-colors">Terms</a>
                <a href="#" className="hover:text-white transition-colors">Support</a>
                <Link to="/evals" className="hover:text-white transition-colors">Evals</Link>
              </div>
              <div className="text-white/20 text-xs">
                © 2026 ConciergeAI. All rights reserved.
              </div>
            </div>
          </footer>
        </div>
      </Router>
    </AuthContext.Provider>
  );
}
