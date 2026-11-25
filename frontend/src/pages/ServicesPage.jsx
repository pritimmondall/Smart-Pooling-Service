import React, { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Compass,
  Search,
  Clock,
  MapPin,
  Users,
  ArrowRight,
  Sparkles,
  AlertCircle,
} from 'lucide-react';
import { servicesApi } from '../api/client.js';
import LoadingSpinner from '../components/common/LoadingSpinner.jsx';
import EmptyState from '../components/common/EmptyState.jsx';

export default function ServicesPage() {
  const navigate = useNavigate();
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [searchQuery, setSearchQuery] = useState('');

  useEffect(() => {
    let mounted = true;
    async function loadServices() {
      try {
        setLoading(true);
        setError(null);
        const res = await servicesApi.listActive();
        if (mounted) {
          setServices(res?.data || []);
        }
      } catch (err) {
        if (mounted) setError(err.message || 'Failed to load service categories.');
      } finally {
        if (mounted) setLoading(false);
      }
    }

    loadServices();
    return () => {
      mounted = false;
    };
  }, []);

  const filteredServices = services.filter((s) => {
    const q = searchQuery.toLowerCase();
    return (
      s.name.toLowerCase().includes(q) ||
      (s.description && s.description.toLowerCase().includes(q))
    );
  });

  if (loading) {
    return <LoadingSpinner label="Loading service catalog..." size="lg" className="py-24" />;
  }

  return (
    <div className="space-y-6">
      {/* Header & Search */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-2 border-b border-slate-200/80">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 flex items-center gap-2">
            <Compass className="w-6 h-6 text-emerald-600" />
            Discover Home Services
          </h1>
          <p className="text-xs sm:text-sm text-slate-500 mt-1">
            Browse home maintenance and repair services available for smart pooling
          </p>
        </div>

        {/* Search Input */}
        <div className="relative w-full sm:w-72">
          <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
          <input
            type="text"
            placeholder="Search service name or description..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="glass-input w-full pl-10 text-xs"
          />
        </div>
      </div>

      {error && (
        <div className="p-4 rounded-2xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-3">
          <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Info Banner on Pooling Advantage */}
      <div className="glass-panel rounded-2xl p-4 bg-emerald-50/60 border-emerald-200/60 text-emerald-950 flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-emerald-600 text-white flex items-center justify-center shrink-0">
            <Sparkles className="w-5 h-5 stroke-[2]" />
          </div>
          <div>
            <p className="text-xs font-bold text-emerald-900">
              How Smart Service Pooling Works
            </p>
            <p className="text-[11px] text-emerald-700 leading-snug">
              Choose your location and preferred time. SmartPool groups nearby bookings for the same service and assigns an available technician.
            </p>
          </div>
        </div>
      </div>

      {/* Services Grid */}
      {filteredServices.length === 0 ? (
        <EmptyState
          title="No services match your query"
          description="Try searching with a different keyword, or clear the search input to see all categories."
          actionLabel="Clear Search"
          onAction={() => setSearchQuery('')}
        />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filteredServices.map((service) => (
            <div
              key={service._id}
              className="glass-card rounded-2xl p-6 border border-slate-200/80 flex flex-col justify-between"
            >
              <div>
                <div className="flex items-start justify-between gap-3 mb-2">
                  <h3 className="font-bold text-slate-900 text-base">{service.name}</h3>
                  <div className="text-right">
                    <span className="text-base font-extrabold text-slate-900 block">
                      ₹{service.baseIndividualPrice}
                    </span>
                    <span className="text-[10px] text-slate-400 uppercase font-semibold">
                      Individual Base
                    </span>
                  </div>
                </div>

                <p className="text-xs text-slate-600 line-clamp-3 leading-relaxed mb-4">
                  {service.description || 'Verified on-demand professional service.'}
                </p>

                {/* Service Specs */}
                <div className="grid grid-cols-3 gap-2 py-3 border-y border-slate-100 text-[11px] text-slate-500 mb-4">
                  <div className="flex flex-col items-center text-center">
                    <Clock className="w-3.5 h-3.5 text-slate-400 mb-1" />
                    <span className="font-medium text-slate-700">~{service.estimatedDurationMins}m</span>
                    <span className="text-[9px] text-slate-400">Duration</span>
                  </div>
                  <div className="flex flex-col items-center text-center">
                    <MapPin className="w-3.5 h-3.5 text-slate-400 mb-1" />
                    <span className="font-medium text-slate-700">{service.defaultPoolRadiusKm} km</span>
                    <span className="text-[9px] text-slate-400">Pool Radius</span>
                  </div>
                  <div className="flex flex-col items-center text-center">
                    <Users className="w-3.5 h-3.5 text-slate-400 mb-1" />
                    <span className="font-medium text-slate-700">Up to {service.maxPoolSize}</span>
                    <span className="text-[9px] text-slate-400">Max Pool</span>
                  </div>
                </div>
              </div>

              <button
                type="button"
                onClick={() => navigate(`/create-booking?serviceId=${service._id}`)}
                className="glass-button-primary w-full text-xs font-semibold py-2.5"
              >
                Book This Service
                <ArrowRight className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
