import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  Wrench,
  CheckCircle2,
  Clock,
  AlertCircle,
  MapPin,
  Calendar,
  Phone,
  User,
  CheckSquare,
  RefreshCw,
  Navigation,
  AlertTriangle,
  XCircle,
  Play,
  Wallet,
  Car,
  Layers,
  ChevronRight,
  ChevronDown,
  ChevronUp,
  Info,
} from 'lucide-react';
import { Navigate, useLocation } from 'react-router-dom';
import './TechnicianDashboard.css';
import { useAuth } from '../context/AuthContext.jsx';
import { techniciansApi } from '../api/client.js';
import TechnicianDay, { VisitException } from '../components/common/TechnicianDay.jsx';
import StatusBadge from '../components/common/StatusBadge.jsx';
import LoadingSpinner from '../components/common/LoadingSpinner.jsx';
import EmptyState from '../components/common/EmptyState.jsx';
import Modal from '../components/common/Modal.jsx';
import { formatRouteMetric } from '../utils/routeFormatters.js';

export { formatRouteMetric };

export default function TechnicianDashboard() {
  const { user } = useAuth();
  const { pathname } = useLocation();

  // State
  const [earnings, setEarnings] = useState(null);
  const [profile, setProfile] = useState(null);
  const [jobPage, setJobPage] = useState(1);
  const [jobPages, setJobPages] = useState(1);
  const [jobs, setJobs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [actionSuccess, setActionSuccess] = useState(null);

  const [counts, setCounts] = useState({});
  const [routes, setRoutes] = useState([]);
  const requestId = useRef(0);

  // Filters
  const [statusFilter, setStatusFilter] = useState('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [searchQuery, setSearchQuery] = useState('');

  const [query, setQuery] = useState('');
  useEffect(() => {
    const timer = setTimeout(() => setQuery(searchQuery.trim()), 250);
    return () => clearTimeout(timer);
  }, [searchQuery]);

  // Availability mutation state
  const [updatingAvailability, setUpdatingAvailability] = useState(false);

  // Job Action Processing state (map of jobId -> boolean)
  const [processingJobs, setProcessingJobs] = useState({});

  // Route Modal State
  const [routeModalOpen, setRouteModalOpen] = useState(false);
  const [routeLoading, setRouteLoading] = useState(false);
  const [routeData, setRouteData] = useState(null);
  const [routeError, setRouteError] = useState(null);
  const [activeRouteJob, setActiveRouteJob] = useState(null);

  // Details Modal State
  const [detailsModalOpen, setDetailsModalOpen] = useState(false);
  const [selectedJob, setSelectedJob] = useState(null);

  // Rejection & Cancellation Reason Modals
  const [rejectModalOpen, setRejectModalOpen] = useState(false);
  const [jobToReject, setJobToReject] = useState(null);
  const [rejectionReason, setRejectionReason] = useState('');

  const [cancelModalOpen, setCancelModalOpen] = useState(false);
  const [jobToCancel, setJobToCancel] = useState(null);
  const [cancellationReason, setCancellationReason] = useState('');

  // Stop-level progression state for pooled jobs
  const [incident, setIncident] = useState(null);
  const openIncident = (route, visit) => setIncident({ route, visit });
  const [jobStops, setJobStops] = useState({});
  const [stopsLoading, setStopsLoading] = useState({});
  const [stopsError, setStopsError] = useState({});
  const [expandedStops, setExpandedStops] = useState({});
  const [processingStops, setProcessingStops] = useState({});

  // Fetch stops for a specific pooled job
  const fetchStops = useCallback(async (jobId, isSilent = false) => {
    if (!jobId) return;
    try {
      if (!isSilent) setStopsLoading((prev) => ({ ...prev, [jobId]: true }));
      setStopsError((prev) => ({ ...prev, [jobId]: null }));
      const res = await techniciansApi.getJobStops(jobId);
      setJobStops((prev) => ({ ...prev, [jobId]: res?.data }));
      return res?.data;
    } catch (err) {
      setStopsError((prev) => ({
        ...prev,
        [jobId]: err.message || 'Failed to load stops for this job.',
      }));
    } finally {
      setStopsLoading((prev) => ({ ...prev, [jobId]: false }));
    }
  }, []);

  // Toggle expanded state for a pooled job's stops
  const toggleStops = (jobId) => {
    setExpandedStops((prev) => {
      const isCurrentlyExpanded = Boolean(prev[jobId]);
      const next = !isCurrentlyExpanded;
      if (next && !jobStops[jobId]) {
        fetchStops(jobId);
      }
      return { ...prev, [jobId]: next };
    });
  };

  // Fetch technician profile and assigned jobs
  const fetchData = useCallback(async (isSilent = false) => {
    const request = ++requestId.current;
    try {
      if (!isSilent) setLoading(true);
      else setRefreshing(true);
      setError(null);

      const [profileRes, jobsRes, earningsRes, routeRes] = await Promise.all([
        techniciansApi.getMe(),

        techniciansApi.getMyJobs({ limit: 50, page: jobPage, status: statusFilter === 'all' ? undefined : statusFilter, type: typeFilter === 'all' ? undefined : typeFilter, q: query }),
        techniciansApi.getEarnings(), techniciansApi.activeRoutes(),
      ]);

      if (request !== requestId.current) return;
      setCounts(jobsRes.meta.counts);
      setRoutes(routeRes.data);
      const fetchedJobs = jobsRes?.data || [];
      setProfile(profileRes?.data || null);
      setJobs(fetchedJobs);
      setJobPages(jobsRes.meta.pagination.pages);
      if (jobPage > jobsRes.meta.pagination.pages) setJobPage(jobsRes.meta.pagination.pages);
      setEarnings(earningsRes.data);

      // Pre-load stops for active pooled jobs and expand them by default
      const activePools = fetchedJobs.filter(
        (j) => j.jobType === 'pool' && ['accepted', 'in_progress'].includes(j.status)
      );
      for (const pool of activePools) {
        fetchStops(pool._id, true);
        setExpandedStops((prev) => (prev[pool._id] === undefined ? { ...prev, [pool._id]: true } : prev));
      }
    } catch (err) {
      if (request === requestId.current) setError(err.message || 'Failed to load technician dashboard data.');
    } finally {
      if (request === requestId.current) { setLoading(false); setRefreshing(false); }
    }
  }, [fetchStops, jobPage, statusFilter, typeFilter, query]);

  useEffect(() => {
    fetchData(true);
    const timer = setInterval(() => fetchData(true), 15000);
    return () => { clearInterval(timer); requestId.current++; };
  }, [fetchData]);

  // Flash message helper
  const showFeedback = (msg) => {
    setActionSuccess(msg);
    setTimeout(() => setActionSuccess(null), 5000);
  };

  // Availability Update
  const handleUpdateAvailability = async (newStatus) => {
    if (updatingAvailability || profile?.availabilityStatus === newStatus) return;
    try {
      setUpdatingAvailability(true);
      setError(null);
      const res = await techniciansApi.updateAvailability({ availabilityStatus: newStatus });
      setProfile(res?.data || { ...profile, availabilityStatus: newStatus });
      showFeedback(`Availability updated to "${newStatus}".`);
      await fetchData(true);
    } catch (err) {
      setError(err.message || 'Failed to update availability status.');
    } finally {
      setUpdatingAvailability(false);
    }
  };

  // Accept Job
  const handleAcceptJob = async (jobId) => {
    if (processingJobs[jobId]) return;
    try {
      setProcessingJobs((prev) => ({ ...prev, [jobId]: true }));
      setError(null);
      await techniciansApi.acceptJob(jobId);
      showFeedback('Job successfully accepted. You are ready to service this job.');
      await Promise.all([fetchData(true), fetchStops(jobId, true)]);
      setExpandedStops((prev) => ({ ...prev, [jobId]: true }));
      if (selectedJob?._id === jobId) setDetailsModalOpen(false);
    } catch (err) {
      setError(err.message || 'Failed to accept job.');
    } finally {
      setProcessingJobs((prev) => ({ ...prev, [jobId]: false }));
    }
  };

  // Handle arrive at stop
  const handleArriveStop = async (jobId, stopId, depart = false) => {
    if (processingStops[stopId]) return;
    try {
      setProcessingStops((prev) => ({ ...prev, [stopId]: true }));
      setError(null);
      if (depart) await techniciansApi.departJobStop(jobId, stopId);
      else await techniciansApi.arriveJobStop(jobId, stopId);
      showFeedback(depart ? 'Customer notified that you are on the way.' : 'Arrival recorded at stop. You can now begin service work.');
      await Promise.all([fetchStops(jobId, true), fetchData(true)]);
    } catch (err) {
      setError(err.message || 'Failed to record arrival at stop.');
    } finally {
      setProcessingStops((prev) => ({ ...prev, [stopId]: false }));
    }
  };

  // Handle start stop service
  const handleStartStop = async (jobId, stopId) => {
    if (processingStops[stopId]) return;
    try {
      setProcessingStops((prev) => ({ ...prev, [stopId]: true }));
      setError(null);
      await techniciansApi.startJobStop(jobId, stopId);
      showFeedback('Service work started at stop.');
      await Promise.all([fetchStops(jobId, true), fetchData(true)]);
    } catch (err) {
      setError(err.message || 'Failed to start service work.');
    } finally {
      setProcessingStops((prev) => ({ ...prev, [stopId]: false }));
    }
  };

  // Handle complete stop service
  const handleCompleteStop = async (jobId, stopId) => {
    if (processingStops[stopId]) return;
    try {
      setProcessingStops((prev) => ({ ...prev, [stopId]: true }));
      setError(null);
      const res = await techniciansApi.completeJobStop(jobId, stopId);
      if (res?.data?.isParentJobFinished) {
        showFeedback('All stops finished! Entire service pool is now completed.');
      } else {
        showFeedback('Service completed at stop. Advancing to next stop.');
      }
      await Promise.all([fetchStops(jobId, true), fetchData(true)]);
    } catch (err) {
      setError(err.message || 'Failed to complete service work.');
    } finally {
      setProcessingStops((prev) => ({ ...prev, [stopId]: false }));
    }
  };

  // Prompt Reject Job
  const promptRejectJob = (job) => {
    setJobToReject(job);
    setRejectionReason('Schedule conflict or unable to service this area at this time.');
    setRejectModalOpen(true);
  };

  // Confirm Reject Job
  const handleConfirmReject = async () => {
    if (!jobToReject) return;
    const jobId = jobToReject._id;
    try {
      setProcessingJobs((prev) => ({ ...prev, [jobId]: true }));
      setError(null);
      await techniciansApi.rejectJob(jobId, rejectionReason);
      setRejectModalOpen(false);
      setJobToReject(null);
      showFeedback('Job assignment has been rejected and released for reassignment.');
      await fetchData(true);
      if (selectedJob?._id === jobId) setDetailsModalOpen(false);
    } catch (err) {
      setError(err.message || 'Failed to reject job.');
    } finally {
      setProcessingJobs((prev) => ({ ...prev, [jobId]: false }));
    }
  };

  // Start Job (Transition to in_progress)
  const handleStartJob = async (jobId) => {
    if (processingJobs[jobId]) return;
    try {
      setProcessingJobs((prev) => ({ ...prev, [jobId]: true }));
      setError(null);
      await techniciansApi.updateJobStatus(jobId, 'in_progress');
      showFeedback('Job marked In Progress. Your status is now set to Busy.');
      await fetchData(true);
      if (selectedJob?._id === jobId) setDetailsModalOpen(false);
    } catch (err) {
      setError(err.message || 'Failed to start job.');
    } finally {
      setProcessingJobs((prev) => ({ ...prev, [jobId]: false }));
    }
  };

  // Complete Job (Transition to completed)
  const handleCompleteJob = async (jobId) => {
    if (processingJobs[jobId]) return;
    try {
      setProcessingJobs((prev) => ({ ...prev, [jobId]: true }));
      setError(null);
      await techniciansApi.updateJobStatus(jobId, 'completed');
      showFeedback('Job marked as Completed! Your completed job counter has been incremented.');
      await fetchData(true);
      if (selectedJob?._id === jobId) setDetailsModalOpen(false);
    } catch (err) {
      setError(err.message || 'Failed to complete job.');
    } finally {
      setProcessingJobs((prev) => ({ ...prev, [jobId]: false }));
    }
  };

  // Prompt Cancel Job
  const promptCancelJob = (job) => {
    setJobToCancel(job);
    setCancellationReason('');
    setCancelModalOpen(true);
  };

  // Confirm Cancel Job
  const handleConfirmCancel = async () => {
    if (!jobToCancel) return;
    const jobId = jobToCancel._id;
    if (!cancellationReason.trim()) {
      setError('A cancellation reason is required.');
      return;
    }
    try {
      setProcessingJobs((prev) => ({ ...prev, [jobId]: true }));
      setError(null);
      await techniciansApi.updateJobStatus(jobId, 'cancelled', cancellationReason);
      setCancelModalOpen(false);
      setJobToCancel(null);
      showFeedback('Job has been cancelled and availability recalculated.');
      await fetchData(true);
      if (selectedJob?._id === jobId) setDetailsModalOpen(false);
    } catch (err) {
      setError(err.message || 'Failed to cancel job.');
    } finally {
      setProcessingJobs((prev) => ({ ...prev, [jobId]: false }));
    }
  };

  // Open Route Modal
  const handleViewRoute = async (job, replan = false) => {
    setActiveRouteJob(job);
    setRouteModalOpen(true);
    setRouteLoading(true);
    setRouteData(null);
    setRouteError(null);

    try {
      const res = replan ? await techniciansApi.replan(job._id) : await techniciansApi.getJobRoute(job._id);
      if (replan) await fetchData(true);
      setRouteData(res?.data || null);
    } catch (err) {
      setRouteError(err.message || 'Failed to load optimized route information.');
    } finally {
      setRouteLoading(false);
    }
  };

  // Open Detailed Job Modal
  const handleOpenDetails = async (job) => {
    try {
      setSelectedJob(job);
      setDetailsModalOpen(true);
      // Fetch full unmasked details
      const res = await techniciansApi.getJobById(job._id);
      if (res?.data) {
        setSelectedJob(res.data);
      }
    } catch (err) {
      console.warn('Could not fetch full job details:', err.message);
    }
  };

  const filteredJobs = jobs;
  const inProgress = (counts.in_progress || 0) + (counts.arrived || 0);
  const pending = counts.assigned || 0;
  const activeCount = pending + inProgress + (counts.accepted || 0);
  const maxCapacity = profile?.maxPoolCapacity || 4;
  const currentWorkload = profile?.activeWorkload !== undefined ? profile.activeWorkload : activeCount;
  const availableBlocked = profile?.approvalStatus !== 'approved' || inProgress > 0 || currentWorkload >= maxCapacity;
  const fare = paise => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR', maximumFractionDigits: 2,
    minimumFractionDigits: 0 }).format(paise / 100);
  const jobsOnly = pathname === '/technician/jobs';
  if (loading) {
    return <LoadingSpinner label="Loading technician dashboard..." size="lg" className="py-24" />;
  }

  if (!profile) return <div role="alert" className="glass-panel p-6 rounded-xl">
    <p>{error || 'Your technician profile could not be loaded.'}</p>
    <button className="underline" onClick={() => fetchData()}>Retry</button>
  </div>;
  if (profile.approvalStatus === 'pending' && !profile.serviceCategories.length && !activeCount) {
    return <Navigate to="/technician/profile-setup" replace/>;
  }
  const workNotice = profile.approvalStatus === 'pending' ? 'Your work profile is awaiting admin approval. You can go available after it is approved.' :
    profile.approvalStatus === 'rejected' ? 'Your technician application was declined. Contact your administrator for a review.' :
    !profile.serviceCategories.length ? 'Choose your service fields in your work profile to find matching jobs.' :
    profile.availabilityStatus !== 'available' && !inProgress && currentWorkload < maxCapacity ?
      'Set Work availability to Available when you are ready to receive jobs.' : '';
  return (
    <div className="tech-desk">
      {/* Top Feedback Banner */}
      {actionSuccess && (
        <div role="status" className="p-4 rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs sm:text-sm font-medium flex items-center justify-between shadow-sm animate-fade-in">
          <div className="flex items-center gap-2.5">
            <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
            <span>{actionSuccess}</span>
          </div>
          <button
            type="button"
            onClick={() => setActionSuccess(null)}
            className="text-emerald-700 hover:text-emerald-900 text-xs font-semibold"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Top Error Banner */}
      {error && (
        <div role="alert" className="p-4 rounded-2xl bg-rose-50 border border-rose-200 text-rose-800 text-xs sm:text-sm font-medium flex items-center justify-between shadow-sm animate-fade-in">
          <div className="flex items-center gap-2.5">
            <AlertCircle className="w-5 h-5 text-rose-600 shrink-0" />
            <span>{error}</span>
          </div>
          <button
            type="button"
            onClick={() => setError(null)}
            className="text-rose-700 hover:text-rose-900 text-xs font-semibold"
          >
            Dismiss
          </button>
        </div>
      )}

      <header className="desk-heading">
        <div><p className="desk-date"><Calendar size={15}/><time>{new Date().toLocaleDateString('en-IN', {
          weekday: 'long', day: 'numeric', month: 'long'
        })}</time></p>
          <h1>{jobsOnly ? 'Assigned jobs' : 'Field dashboard'}</h1>
          <p className="desk-identity">{[user?.name, profile?.zoneId?.name, profile?.serviceCategories?.map(c => c.name).join(', ')].filter(Boolean).join(' · ')}</p>
        </div>
        <div className="desk-controls">
          <label className="desk-status"><span className={'desk-dot ' + (profile?.availabilityStatus || '')}/>
            <select aria-label="Work availability" value={profile?.availabilityStatus || ''} disabled={updatingAvailability || !profile}
              onChange={e => handleUpdateAvailability(e.target.value)}>
              {!profile?.availabilityStatus && <option value="">Status unavailable</option>}
              {profile?.availabilityStatus === 'busy' && <option value="busy">Busy</option>}
              <option value="available" disabled={availableBlocked}>Available</option>
              <option value="unavailable">Unavailable</option><option value="offline">Offline</option>
            </select>
          </label>
          <button className="desk-refresh" aria-label="Refresh dashboard" title="Refresh dashboard" disabled={refreshing} onClick={() => fetchData(true)}>
            <RefreshCw size={17} className={refreshing ? 'animate-spin' : undefined}/>
          </button>
        </div>
      </header>

      {workNotice && <p role="status" className="rounded-xl border border-emerald-200 bg-emerald-50 p-4 text-sm">{workNotice}</p>}
      {!jobsOnly && <><div className="desk-metrics">
        <div><span><Layers/>Active jobs</span><strong>{currentWorkload}<small> / {maxCapacity}</small></strong>
          <meter aria-label="Workload capacity" min="0" max={maxCapacity} value={currentWorkload}/></div>
        <a href="#assigned-work" onClick={() => { setStatusFilter('assigned'); setTypeFilter('all'); setSearchQuery(''); setJobPage(1); }}>
          <span><Clock/>Awaiting acceptance</span><strong>{pending}</strong><small>Assigned jobs <ChevronRight size={12}/></small></a>
        <div><span><CheckCircle2/>Completed jobs</span><strong>{profile?.jobsCompleted || counts.completed || 0}</strong><small>{inProgress} in progress</small></div>
        <a href="#field-earnings"><span><Wallet/>Today’s earnings</span><strong>{earnings ? fare(earnings.todayPaise) : '—'}</strong><small>Completed fares <ChevronRight size={12}/></small></a>
      </div>

      <TechnicianDay routes={routes} processing={processingStops} onArrive={handleArriveStop} onStart={handleStartStop}
        onComplete={handleCompleteStop} openIncident={openIncident} pending={pending}/>


      <div className="desk-earnings-section">
        <aside className="desk-ledger" id="field-earnings">
          <Wallet size={21}/><h2>Estimated earnings</h2>
          <strong>{earnings ? fare(earnings.totalPaise) : '—'}</strong><p>Lifetime total</p>
          <dl><div><dt>Today</dt><dd>{earnings ? fare(earnings.todayPaise) : '—'}</dd></div>
            <div><dt>Completed services</dt><dd>{earnings?.completedServices ?? '—'}</dd></div></dl>
        </aside>
      </div>

      </>}
      {incident && <VisitException incident={incident} onClose={() => setIncident(null)} onRefresh={fetchData} onFeedback={showFeedback}/>}
      <section className="desk-jobs space-y-4" id="assigned-work">
        <div className="desk-section-title">
          <h2>{jobsOnly ? 'Job history and assignments' : 'Assigned jobs'}</h2>
          <input type="search" aria-label="Search assigned jobs" placeholder="Search jobs, customers, addresses" value={searchQuery}
            onChange={e => { setJobPage(1); setSearchQuery(e.target.value); }} className="glass-input"/>
        </div>

        {/* Filter Tabs */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          {/* Status Tabs */}
          <div className="flex flex-wrap items-center gap-1.5 p-1 bg-slate-100 rounded-xl">
            {[
              { id: 'all', label: 'All Jobs', count: counts.all || 0 },
              { id: 'assigned', label: 'Assigned', count: counts.assigned || 0 },
              { id: 'arrived', label: 'Arrived', count: counts.arrived || 0 },
              { id: 'accepted', label: 'Accepted', count: counts.accepted || 0 },
              { id: 'in_progress', label: 'In Progress', count: counts.in_progress || 0 },
              { id: 'completed', label: 'Completed', count: counts.completed || 0 },
              { id: 'cancelled', label: 'Cancelled', count: counts.cancelled || 0 },
            ].map((tab) => (
              <button
                key={tab.id}
                aria-pressed={statusFilter === tab.id}
                type="button"
                onClick={() => { setJobPage(1); setStatusFilter(tab.id); }}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-all flex items-center gap-1.5 ${
                  statusFilter === tab.id
                    ? 'bg-white text-indigo-900 shadow-xs'
                    : 'text-slate-600 hover:text-slate-900'
                }`}
              >
                <span>{tab.label}</span>
                <span
                  className={`text-[10px] px-1.5 py-0.2 rounded-full ${
                    statusFilter === tab.id ? 'bg-indigo-100 text-indigo-800' : 'bg-slate-200 text-slate-600'
                  }`}
                >
                  {tab.count}
                </span>
              </button>
            ))}
          </div>

          {/* Type Filter */}
          <div className="flex items-center gap-1.5 text-xs text-slate-500">
            <span>Type:</span>
            <select
              aria-label="Job type"
              value={typeFilter}
              onChange={(e) => { setJobPage(1); setTypeFilter(e.target.value); }}
              className="glass-input text-xs py-1 px-2.5 rounded-lg bg-white"
            >
              <option value="all">All Types</option>
              <option value="pool">Pooled Work Only</option>
              <option value="individual">Individual Bookings Only</option>
            </select>
          </div>
        </div>

        {/* Jobs Listing */}
        {jobPages > 1 && <nav aria-label="Job history pages" className="flex items-center gap-4">
          <button disabled={jobPage === 1} onClick={() => setJobPage(jobPage - 1)}>Previous</button>
          <span>Page {jobPage} of {jobPages}</span>
          <button disabled={jobPage >= jobPages} onClick={() => setJobPage(jobPage + 1)}>Next</button>
        </nav>}
        {filteredJobs.length === 0 ? (
          <EmptyState
            title="No assigned jobs"
            description={
              searchQuery || statusFilter !== 'all' || typeFilter !== 'all'
                ? 'No assigned jobs match your active filter criteria.'
                : 'You do not have any assigned jobs at this moment. Stay available to receive upcoming bookings.'
            }
          />
        ) : (
          <div className="grid grid-cols-1 gap-4">
            {filteredJobs.map((job) => {
              const isPool = job.jobType === 'pool';
              const isProcessing = Boolean(processingJobs[job._id]);

              return (
                <div
                  key={job._id}
                  className="glass-panel bg-white/95 rounded-2xl p-5 border border-slate-200/90 shadow-xs hover:shadow-md transition-shadow relative overflow-hidden"
                >
                  {/* Left accent bar */}
                  <div
                    className={`absolute left-0 top-0 bottom-0 w-1.5 ${
                      isPool ? 'bg-indigo-500' : 'bg-emerald-500'
                    }`}
                  />

                  <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-5 pl-2">
                    {/* Job Main Information */}
                    <div className="space-y-3 flex-1">
                      {/* Top Badges */}
                      <div className="flex flex-wrap items-center gap-2">
                        {isPool ? (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-indigo-50 text-indigo-800 border border-indigo-200/60">
                            <Layers className="w-3.5 h-3.5" />
                            Smart Service Pool ({job.memberCount || 0} Members)
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-bold bg-emerald-50 text-emerald-800 border border-emerald-200/60">
                            <User className="w-3.5 h-3.5" />
                            Individual Booking
                          </span>
                        )}

                        <StatusBadge status={job.status} />

                        <span className="text-[11px] font-mono text-slate-400">
                          ID: {job._id.slice(-8)}
                        </span>
                      </div>

                      {/* Title & Service Details */}
                      <div>
                        <h3 className="text-base font-bold text-slate-900">
                          {job.specificService || job.serviceCategory?.name || 'General Service'}
                        </h3>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {job.zone?.name || 'Zone unassigned'}
                          {job.zone?.city ? `, ${job.zone.city}` : ''}
                        </p>
                      </div>

                      {/* Scheduling & Customer / Location Preview */}
                      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-3 text-xs text-slate-600 bg-slate-50/70 p-3 rounded-xl border border-slate-100">
                        {/* Time Window */}
                        <div className="flex items-start gap-2">
                          <Calendar className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" />
                          <div>
                            <span className="font-semibold block text-slate-700">Scheduled Time</span>
                            <span>
                              {job.timeWindow?.start
                                ? new Date(job.timeWindow.start).toLocaleDateString(undefined, {
                                    month: 'short',
                                    day: 'numeric',
                                    year: 'numeric',
                                  })
                                : 'Flexible'}
                            </span>
                            <span className="block text-[11px] text-slate-400">
                              {job.timeWindow?.start
                                ? `${new Date(job.timeWindow.start).toLocaleTimeString([], {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })} - ${new Date(job.timeWindow.end).toLocaleTimeString([], {
                                    hour: '2-digit',
                                    minute: '2-digit',
                                  })}`
                                : ''}
                            </span>
                          </div>
                        </div>

                        {/* Customer / Pool Info */}
                        {isPool ? (
                          <div className="flex items-start gap-2">
                            <Layers className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" />
                            <div>
                              <span className="font-semibold block text-slate-700">Pool Capacity</span>
                              <span>{job.memberCount || 0} active member stops</span>
                              <span className="block text-[11px] text-slate-400">
                                Max capacity: {job.maxCapacity || 4}
                              </span>
                            </div>
                          </div>
                        ) : (
                          <div className="flex items-start gap-2">
                            <User className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" />
                            <div>
                              <span className="font-semibold block text-slate-700">Customer</span>
                              <span>{job.customer?.name || 'Customer'}</span>
                              {job.customer?.phone && (
                                <a
                                  href={`tel:${job.customer.phone}`}
                                  className="block text-[11px] text-indigo-600 hover:underline"
                                >
                                  {job.customer.phone}
                                </a>
                              )}
                            </div>
                          </div>
                        )}

                        {/* Location / Pricing */}
                        <div className="flex items-start gap-2">
                          <MapPin className="w-4 h-4 text-indigo-500 shrink-0 mt-0.5" />
                          <div>
                            <span className="font-semibold block text-slate-700">
                              {isPool ? 'Pool Centroid' : 'Address'}
                            </span>
                            <span className="block line-clamp-2 text-[11px] text-slate-600">
                              {job.addressText ||
                                (job.centroidLocation
                                  ? `${job.centroidLocation.coordinates[1].toFixed(4)}, ${job.centroidLocation.coordinates[0].toFixed(4)}`
                                  : 'Location provided in details')}
                            </span>
                            {job.estimatedPrice !== undefined && (
                              <span className="block text-[11px] font-semibold text-emerald-700 mt-0.5">
                                Est. Price: ₹{job.estimatedPrice}
                              </span>
                            )}
                          </div>
                        </div>
                      </div>
                    </div>

                    {/* Action Buttons & Workflow State Machine */}
                    <div className="flex flex-col sm:flex-row lg:flex-col items-stretch sm:items-center lg:items-end justify-center gap-2 shrink-0 pt-2 lg:pt-0 border-t lg:border-t-0 border-slate-100">
                      { ['assigned', 'accepted', 'arrived', 'in_progress'].includes(job.status) && <button
                        type="button"
                        onClick={() => handleViewRoute(job)}
                        className="px-3.5 py-2 rounded-xl text-xs font-semibold bg-indigo-50 text-indigo-700 border border-indigo-200/80 hover:bg-indigo-100 flex items-center justify-center gap-1.5 transition-colors"
                      >
                        <Car className="w-4 h-4" />
                        {isPool ? 'View Optimized Route' : 'View Stop & Route'}
                      </button>}

                      {isPool && !job.poolScope && ['accepted','in_progress'].includes(job.status) && <button
                        className="text-xs font-semibold text-indigo-700" onClick={() => handleViewRoute(job, true)}>Replan remaining visits</button>}
                      {/* Details Button */}
                      <button
                        type="button"
                        onClick={() => handleOpenDetails(job)}
                        className="px-3.5 py-2 rounded-xl text-xs font-medium text-slate-600 hover:text-slate-900 hover:bg-slate-100 flex items-center justify-center gap-1 transition-colors"
                      >
                        <span>Full Details</span>
                        <ChevronRight className="w-3.5 h-3.5" />
                      </button>

                      {/* Dynamic Lifecycle Actions */}
                      {job.status === 'assigned' && (
                        <div className="flex items-center gap-2 w-full">
                          <button
                            type="button"
                            disabled={isProcessing}
                            onClick={() => handleAcceptJob(job._id)}
                            className="flex-1 px-4 py-2 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white flex items-center justify-center gap-1.5 shadow-xs disabled:opacity-50"
                          >
                            <CheckCircle2 className="w-3.5 h-3.5" />
                            {isProcessing ? 'Processing...' : 'Accept'}
                          </button>
                          <button
                            type="button"
                            disabled={isProcessing}
                            onClick={() => promptRejectJob(job)}
                            className="px-3 py-2 rounded-xl text-xs font-medium text-rose-700 bg-rose-50 border border-rose-200 hover:bg-rose-100 disabled:opacity-50"
                          >
                            Reject
                          </button>
                        </div>
                      )}

                      {job.status === 'accepted' && (
                        <div className="flex items-center gap-2 w-full">
                          {isPool ? (
                            <button
                              type="button"
                              onClick={() => toggleStops(job._id)}
                              className="flex-1 px-3.5 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white flex items-center justify-center gap-1.5 shadow-xs transition-colors"
                            >
                              <Layers className="w-3.5 h-3.5" />
                              {expandedStops[job._id] ? 'Hide Stops' : 'Manage Stops'}
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={isProcessing}
                              onClick={() => handleStartJob(job._id)}
                              className="flex-1 px-4 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white flex items-center justify-center gap-1.5 shadow-xs disabled:opacity-50"
                            >
                              <Play className="w-3.5 h-3.5 fill-current" />
                              {isProcessing ? 'Starting...' : 'Start Job'}
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={isProcessing}
                            onClick={() => job.automaticDispatch ? promptRejectJob(job) : promptCancelJob(job)}
                            className="px-3 py-2 rounded-xl text-xs font-medium text-slate-600 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-50"
                          >
                            {job.automaticDispatch ? 'Decline' : 'Cancel'}
                          </button>
                        </div>
                      )}

                      {job.status === 'in_progress' && (
                        <div className="flex items-center gap-2 w-full">
                          {isPool ? (
                            <button
                              type="button"
                              onClick={() => toggleStops(job._id)}
                              className="flex-1 px-3.5 py-2 rounded-xl text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white flex items-center justify-center gap-1.5 shadow-xs transition-colors"
                            >
                              <Layers className="w-3.5 h-3.5" />
                              {expandedStops[job._id] ? 'Hide Stops' : 'Manage Stops'}
                            </button>
                          ) : (
                            <button
                              type="button"
                              disabled={isProcessing}
                              onClick={() => handleCompleteJob(job._id)}
                              className="flex-1 px-4 py-2 rounded-xl text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white flex items-center justify-center gap-1.5 shadow-xs disabled:opacity-50"
                            >
                              <CheckSquare className="w-3.5 h-3.5" />
                              {isProcessing ? 'Completing...' : 'Mark Completed'}
                            </button>
                          )}
                          <button
                            type="button"
                            disabled={isProcessing}
                            onClick={() => promptCancelJob(job)}
                            className="px-3 py-2 rounded-xl text-xs font-medium text-slate-600 hover:text-rose-600 hover:bg-rose-50 disabled:opacity-50"
                          >
                            Cancel
                          </button>
                        </div>
                      )}

                      {job.status === 'completed' && (
                        <span className="text-xs font-semibold text-emerald-700 bg-emerald-50 px-3 py-1.5 rounded-xl border border-emerald-200 flex items-center gap-1.5">
                          <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                          Finished
                        </span>
                      )}

                      {job.status === 'cancelled' && (
                        <span className="text-xs font-medium text-rose-700 bg-rose-50 px-3 py-1.5 rounded-xl border border-rose-200 flex items-center gap-1.5">
                          <XCircle className="w-3.5 h-3.5 text-rose-600" />
                          Cancelled
                        </span>
                      )}
                    </div>
                  </div>

                  {/* Expandable Stop-by-Stop Progression Interface for Pooled Jobs */}
                  {isPool && (
                    <div className="mt-4 pt-3.5 border-t border-slate-100 pl-2">
                      <div className="flex items-center justify-between">
                        <button
                          type="button"
                          onClick={() => toggleStops(job._id)}
                          className="flex items-center gap-2 text-xs font-bold text-slate-800 hover:text-indigo-600 transition-colors group"
                        >
                          <Layers className="w-4 h-4 text-indigo-500 group-hover:scale-110 transition-transform" />
                          <span>Stop Progression Interface ({job.memberCount || 0} Stops)</span>
                          {jobStops[job._id]?.progression && (
                            <span className="text-[11px] font-medium text-slate-500">
                              • {jobStops[job._id].progression.completedStops}/{jobStops[job._id].progression.totalStops} Completed
                            </span>
                          )}
                        </button>

                        <button
                          type="button"
                          onClick={() => toggleStops(job._id)}
                          className="flex items-center gap-1 text-xs text-indigo-600 hover:text-indigo-800 font-semibold transition-colors"
                        >
                          <span>{expandedStops[job._id] ? 'Collapse' : 'Expand'}</span>
                          {expandedStops[job._id] ? (
                            <ChevronUp className="w-3.5 h-3.5" />
                          ) : (
                            <ChevronDown className="w-3.5 h-3.5" />
                          )}
                        </button>
                      </div>

                      {expandedStops[job._id] && (
                        <div className="mt-3 space-y-3">
                          {/* Loading State */}
                          {stopsLoading[job._id] && !jobStops[job._id] && (
                            <div className="p-4 bg-slate-50 rounded-xl text-center text-xs text-slate-500 flex items-center justify-center gap-2 border border-slate-100">
                              <RefreshCw className="w-4 h-4 animate-spin text-indigo-500" />
                              <span>Loading stops progression data...</span>
                            </div>
                          )}

                          {/* Error State */}
                          {stopsError[job._id] && (
                            <div className="p-3 bg-rose-50 border border-rose-200 rounded-xl text-xs text-rose-700 flex items-center justify-between">
                              <span className="flex items-center gap-1.5">
                                <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />
                                {stopsError[job._id]}
                              </span>
                              <button
                                type="button"
                                onClick={() => fetchStops(job._id)}
                                className="px-2.5 py-1 text-[11px] font-semibold bg-rose-100 hover:bg-rose-200 text-rose-800 rounded-lg transition-colors"
                              >
                                Retry
                              </button>
                            </div>
                          )}

                          {/* Stops Stepper Content */}
                          {jobStops[job._id]?.stops && (
                            <div className="space-y-3">
                              {/* Progress bar */}
                              {(() => {
                                const stpData = jobStops[job._id];
                                const total = stpData.stops.length;
                                const done = stpData.stops.filter((s) => s.status === 'completed').length;
                                const pct = total > 0 ? Math.round((done / total) * 100) : 0;
                                return (
                                  <div className="p-3 bg-slate-50/80 rounded-xl border border-slate-100 space-y-1.5">
                                    <div className="flex items-center justify-between text-[11px] text-slate-600 font-medium">
                                      <span>Trip Progress</span>
                                      <span className="font-bold text-slate-800">{done} of {total} stops completed ({pct}%)</span>
                                    </div>
                                    <div className="w-full bg-slate-200/80 h-2 rounded-full overflow-hidden">
                                      <div
                                        className="bg-emerald-500 h-full rounded-full transition-all duration-300"
                                        style={{ width: `${pct}%` }}
                                      />
                                    </div>
                                  </div>
                                );
                              })()}

                              {/* Stop Cards */}
                              <div className="space-y-2.5">
                                {jobStops[job._id].stops.map((stop, sIdx) => {
                                  const isCompleted = stop.status === 'completed';
                                  const isCancelled = stop.status === 'cancelled';
                                  const isInProgress = stop.status === 'in_progress';
                                  const isArrived = stop.status === 'arrived';
                                  const isPendingArrival = ['accepted', 'assigned', 'confirmed'].includes(stop.status);

                                  // Sequential Progression Check: All earlier stops must be completed or cancelled
                                  const earlierStops = jobStops[job._id].stops.slice(0, sIdx);
                                  const earlierIncomplete = earlierStops.find(
                                    (s) => !['completed', 'cancelled'].includes(s.status)
                                  );
                                  const canProgress = !earlierIncomplete && ['accepted', 'in_progress'].includes(job.status);
                                  const isStopProcessing = Boolean(processingStops[stop.bookingId]);

                                  return (
                                    <div
                                      key={stop.bookingId || sIdx}
                                      className={`p-3.5 rounded-xl border transition-all ${
                                        isCompleted
                                          ? 'bg-emerald-50/30 border-emerald-200'
                                          : isCancelled
                                          ? 'bg-rose-50/30 border-rose-200 opacity-70'
                                          : isInProgress
                                          ? 'bg-amber-50/40 border-amber-300 ring-2 ring-amber-400/20'
                                          : isArrived
                                          ? 'bg-indigo-50/40 border-indigo-300 ring-2 ring-indigo-400/20'
                                          : canProgress
                                          ? 'bg-white border-slate-200 shadow-xs'
                                          : 'bg-slate-50/60 border-slate-200/70 opacity-75'
                                      }`}
                                    >
                                      {/* Header: Stop index, Name, Status Badge */}
                                      <div className="flex items-center justify-between gap-2">
                                        <div className="flex items-center gap-2">
                                          {isCompleted ? (
                                            <CheckCircle2 className="w-4 h-4 text-emerald-600 shrink-0" />
                                          ) : isInProgress ? (
                                            <Play className="w-4 h-4 text-amber-600 fill-current shrink-0" />
                                          ) : isArrived ? (
                                            <MapPin className="w-4 h-4 text-indigo-600 shrink-0" />
                                          ) : isCancelled ? (
                                            <XCircle className="w-4 h-4 text-rose-600 shrink-0" />
                                          ) : (
                                            <Clock className="w-4 h-4 text-slate-400 shrink-0" />
                                          )}

                                          <span className="font-bold text-xs text-slate-900">
                                            Stop #{stop.sequenceIndex || sIdx + 1}:
                                          </span>
                                          <span className="text-xs font-medium text-slate-700">
                                            {stop.customer?.name || 'Customer'}
                                          </span>
                                        </div>

                                        <StatusBadge status={stop.status} />
                                      </div>

                                      {/* Details: Address and Phone */}
                                      <div className="mt-2 space-y-1 text-[11px] text-slate-600">
                                        <div className="flex items-start gap-1.5">
                                          <MapPin className="w-3.5 h-3.5 text-slate-400 shrink-0 mt-0.5" />
                                          <span className="line-clamp-2">{stop.addressText || 'Address provided upon arrival'}</span>
                                        </div>
                                        {stop.customer?.phone && stop.customer.phone !== 'N/A' && (
                                          <div className="flex items-center gap-1.5 pl-5">
                                            <Phone className="w-3 h-3 text-indigo-500" />
                                            <a
                                              href={`tel:${stop.customer.phone}`}
                                              className="text-indigo-600 font-semibold hover:underline"
                                            >
                                              {stop.customer.phone}
                                            </a>
                                          </div>
                                        )}
                                      </div>

                                      {/* Execution Timestamps if recorded */}
                                      {(stop.arrivedAt || stop.startedAt || stop.completedAt) && (
                                        <div className="mt-2 pt-2 border-t border-slate-100 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-slate-500">
                                          {stop.arrivedAt && (
                                            <span>
                                              Arrived: {new Date(stop.arrivedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </span>
                                          )}
                                          {stop.startedAt && (
                                            <span>
                                              Started: {new Date(stop.startedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </span>
                                          )}
                                          {stop.completedAt && (
                                            <span className="font-semibold text-emerald-700">
                                              Finished: {new Date(stop.completedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                                            </span>
                                          )}
                                        </div>
                                      )}

                                      {!isCompleted && !isCancelled && ['accepted','in_progress'].includes(job.status) && <button
                                        className="text-xs text-rose-700 mt-2" onClick={() => openIncident({
                                          jobId: job._id, stops: jobStops[job._id].stops.filter(s => !['completed','cancelled'].includes(s.status))
                                        }, stop)}>Report visit issue</button>}
                                      {/* Stop Action Bar */}
                                      <div className="mt-3 pt-2.5 border-t border-slate-100 flex items-center justify-between gap-2">
                                        {job.status === 'assigned' ? (
                                          <span className="text-[11px] text-slate-400 italic">
                                            Accept the pooled job above to enable stop actions.
                                          </span>
                                        ) : isCompleted ? (
                                          <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-700 bg-emerald-100/80 px-2.5 py-1 rounded-lg">
                                            <CheckCircle2 className="w-3.5 h-3.5" /> Stop Finished
                                          </span>
                                        ) : isCancelled ? (
                                          <span className="inline-flex items-center gap-1 text-xs font-medium text-rose-700 bg-rose-100/80 px-2.5 py-1 rounded-lg">
                                            <XCircle className="w-3.5 h-3.5" /> Cancelled {stop.rejectionReason ? `(${stop.rejectionReason})` : ''}
                                          </span>
                                        ) : !canProgress ? (
                                          <span className="inline-flex items-center gap-1.5 text-[11px] text-slate-500 bg-slate-100 px-2.5 py-1 rounded-lg">
                                            <Clock className="w-3.5 h-3.5 text-slate-400" />
                                            Complete Stop #{earlierIncomplete?.sequenceIndex || sIdx} first
                                          </span>
                                        ) : (
                                          <div className="flex items-center gap-2">
                                            {isPendingArrival && (
                                              <button
                                                type="button"
                                                disabled={isStopProcessing}
                                                onClick={() => handleArriveStop(job._id, stop.bookingId, job.automaticDispatch && !stop.departedAt)}
                                                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-indigo-600 hover:bg-indigo-700 text-white flex items-center gap-1.5 shadow-xs disabled:opacity-50 transition-colors"
                                              >
                                                <MapPin className="w-3.5 h-3.5" />
                                                {isStopProcessing ? 'Updating…' : job.automaticDispatch && !stop.departedAt ? 'On the way' : 'Mark Arrived'}
                                              </button>
                                            )}
                                            {isArrived && (
                                              <button
                                                type="button"
                                                disabled={isStopProcessing}
                                                onClick={() => handleStartStop(job._id, stop.bookingId)}
                                                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-amber-600 hover:bg-amber-700 text-white flex items-center gap-1.5 shadow-xs disabled:opacity-50 transition-colors"
                                              >
                                                <Play className="w-3.5 h-3.5 fill-current" />
                                                {isStopProcessing ? 'Starting Service...' : 'Start Service'}
                                              </button>
                                            )}
                                            {isInProgress && (
                                              <button
                                                type="button"
                                                disabled={isStopProcessing}
                                                onClick={() => handleCompleteStop(job._id, stop.bookingId)}
                                                className="px-3 py-1.5 rounded-lg text-xs font-semibold bg-emerald-600 hover:bg-emerald-700 text-white flex items-center gap-1.5 shadow-xs disabled:opacity-50 transition-colors"
                                              >
                                                <CheckSquare className="w-3.5 h-3.5" />
                                                {isStopProcessing ? 'Completing Service...' : 'Complete Service'}
                                              </button>
                                            )}
                                          </div>
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* 5. Route & Stop Sequence Modal */}
      <Modal
        isOpen={routeModalOpen}
        onClose={() => setRouteModalOpen(false)}
        title={
          activeRouteJob?.jobType === 'pool'
            ? 'Optimized Multi-Stop Route'
            : 'Individual Job Route & Stop'
        }
        maxWidth="max-w-3xl"
      >
        {routeLoading ? (
          <LoadingSpinner label="Fetching optimized road network metrics..." size="md" className="py-12" />
        ) : routeError ? (
          <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-amber-800 text-xs flex items-start gap-2.5">
            <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
            <div>
              <p className="font-semibold">Routing Provider Notice</p>
              <p className="mt-0.5 leading-relaxed">{routeError}</p>
            </div>
          </div>
        ) : routeData ? (
          <div className="space-y-6 text-xs">
            {/* Provider and Measurement Type Banner */}
            <div className="flex flex-wrap items-center justify-between gap-3 p-3.5 rounded-2xl bg-slate-50 border border-slate-200">
              <div className="flex items-center gap-2">
                <span className="text-slate-500 font-semibold">Measurement:</span>
                {routeData.roadDistanceCalculated === false || routeData.optimizationStatus === 'provider_unavailable' ? (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-rose-50 text-rose-800 border border-rose-200">
                    <AlertTriangle className="w-3.5 h-3.5 text-rose-600" />
                    Road Routing Unavailable (Fallback Sequence)
                  </span>
                ) : routeData.measurementType === 'actual_road_network' || routeData.provider === 'osrm' ? (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-emerald-50 text-emerald-800 border border-emerald-200">
                    <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" />
                    Actual Road Network (OSRM)
                  </span>
                ) : routeData.measurementType === 'simulated_road_network' || routeData.provider === 'mock' ? (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200">
                    <Info className="w-3.5 h-3.5 text-amber-600" />
                    Simulated Road Network
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-semibold bg-amber-50 text-amber-800 border border-amber-200">
                    <AlertTriangle className="w-3.5 h-3.5 text-amber-600" />
                    Geometric Fallback (Straight-Line Haversine)
                  </span>
                )}
              </div>

              <div className="flex items-center gap-2 text-slate-500 text-[11px]">
                {routeData.originSource && (
                  <span className="px-2 py-0.5 rounded-md bg-slate-200/70 text-slate-700 font-medium">
                    Origin: {routeData.originSource === 'scheduled' ? 'Scheduled departure location' : routeData.originSource === 'live_gps' ? 'Live GPS' : routeData.originSource === 'override' ? 'Selected location' : 'Base Location'}
                    {routeData.isOriginStale ? ' (Stale)' : ''}
                  </span>
                )}
                <span>
                  Algorithm:{' '}
                  <strong className="text-slate-700">
                    {routeData.algorithm === 'branch_and_bound_exact'
                      ? 'Exact Branch & Bound (TSPTW)'
                      : routeData.algorithm === 'nearest_neighbor_2opt'
                      ? 'Nearest Neighbor with 2-opt'
                      : routeData.algorithm?.replaceAll('_', ' ') || 'Standard Route'}
                  </strong>
                </span>
                {routeData.isGloballyOptimal && (
                  <span className="text-emerald-700 font-semibold bg-emerald-100/70 px-2 py-0.5 rounded-md">
                    Globally Optimal
                  </span>
                )}
              </div>
            </div>

            {/* Error / Provider Fallback Notice */}
            {routeData.errorMessage && (
              <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 text-xs flex items-start gap-2.5">
                <AlertCircle className="w-4 h-4 text-rose-600 shrink-0 mt-0.5" />
                <div>
                  <p className="font-semibold">Routing Provider Notice</p>
                  <p className="mt-0.5 leading-relaxed">{routeData.errorMessage}</p>
                </div>
              </div>
            )}

            {/* Provider limitations message */}
            {routeData.limitations && (
              <div className="p-3 rounded-xl bg-amber-50/80 border border-amber-200/80 text-amber-800 text-[11px] flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                <span>{routeData.limitations}</span>
              </div>
            )}

            {/* Route Summary Metrics Grid */}
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
              <div className="p-3 rounded-xl bg-indigo-50/60 border border-indigo-100 text-center">
                <span className="text-[10px] uppercase font-bold text-indigo-600 block">Total Distance</span>
                <span className="text-base font-bold text-indigo-950">
                  {formatRouteMetric(routeData.totalTravelDistance, 'km')}
                </span>
              </div>

              <div className="p-3 rounded-xl bg-indigo-50/60 border border-indigo-100 text-center">
                <span className="text-[10px] uppercase font-bold text-indigo-600 block">Travel Duration</span>
                <span className="text-base font-bold text-indigo-950">
                  {formatRouteMetric(routeData.totalTravelTime, 'mins')}
                </span>
              </div>

              <div className="p-3 rounded-xl bg-indigo-50/60 border border-indigo-100 text-center">
                <span className="text-[10px] uppercase font-bold text-indigo-600 block">Service Time</span>
                <span className="text-base font-bold text-indigo-950">
                  {formatRouteMetric(routeData.totalServiceDuration || routeData.totalServiceTime, 'mins')}
                </span>
              </div>

              <div className="p-3 rounded-xl bg-indigo-50/60 border border-indigo-100 text-center">
                <span className="text-[10px] uppercase font-bold text-indigo-600 block">Est. Total Trip</span>
                <span className="text-base font-bold text-indigo-950">
                  {formatRouteMetric(routeData.totalTripDuration, 'mins')}
                </span>
              </div>
            </div>

            {/* Scheduling Conflicts Warning */}
            {routeData.schedulingConflicts && routeData.schedulingConflicts.length > 0 && (
              <div className="p-3.5 rounded-xl bg-rose-50 border border-rose-200 text-rose-800 space-y-1">
                <div className="font-semibold flex items-center gap-1.5 text-xs">
                  <AlertCircle className="w-4 h-4 text-rose-600" />
                  Scheduling Window Conflicts Detected ({routeData.schedulingConflicts.length})
                </div>
                <div className="space-y-1 pl-5 text-[11px]">
                  {routeData.schedulingConflicts.map((c, i) => (
                    <div key={i}>
                      • Stop {c.customerName || 'Customer'}: {c.conflictDescription}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Ordered Stop Timeline */}
            <div className="space-y-3">
              <h4 className="font-bold text-slate-800 text-sm flex items-center gap-1.5">
                <Navigation className="w-4 h-4 text-indigo-600" />
                Optimized Stop Sequence
              </h4>

              <div className="space-y-3 relative before:absolute before:left-4 before:top-2 before:bottom-2 before:w-0.5 before:bg-slate-200 pl-8">
                {routeData.stops?.map((stop, idx) => (
                  <div
                    key={stop.bookingId || idx}
                    className="p-3.5 rounded-xl border border-slate-200 bg-white relative shadow-2xs space-y-2"
                  >
                    {/* Circle sequence indicator */}
                    <div className="absolute -left-8 top-3.5 w-6 h-6 rounded-full bg-indigo-600 text-white font-bold text-[10px] flex items-center justify-center ring-4 ring-white">
                      {stop.sequenceIndex || idx + 1}
                    </div>

                    <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                      <div>
                        <div className="font-bold text-slate-800 text-xs flex items-center gap-2">
                          <span>{stop.customerName || 'Customer Stop'}</span>
                          {stop.isTimeWindowFeasible === true && (
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 font-medium border border-emerald-200">
                              On Schedule
                            </span>
                          )}
                          {stop.isTimeWindowFeasible === false && (
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-rose-50 text-rose-700 font-medium border border-rose-200">
                              Window Delay
                            </span>
                          )}
                        </div>
                        <p className="text-slate-500 text-[11px] mt-0.5">
                          {stop.addressText || 'Address in booking file'}
                        </p>
                      </div>

                      {Number.isFinite(stop.location?.lat) && Number.isFinite(stop.location?.lng) && (
                        <a className="text-indigo-700 underline text-xs" target="_blank" rel="noreferrer"
                          href={`https://www.google.com/maps/dir/?api=1&destination=${stop.location.lat},${stop.location.lng}`}>Directions</a>
                      )}
                      {stop.customerPhone && (
                        <a
                          href={`tel:${stop.customerPhone}`}
                          className="text-indigo-600 hover:underline font-semibold flex items-center gap-1 shrink-0 text-xs"
                        >
                          <Phone className="w-3 h-3" />
                          {stop.customerPhone}
                        </a>
                      )}
                    </div>

                    {/* Stop Timing Metrics */}
                    <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 pt-2 border-t border-slate-100 text-[11px] text-slate-600">
                      <div>
                        <span className="text-slate-400 block text-[10px]">Est. Arrival</span>
                        <strong className="text-slate-800">
                          {stop.estimatedArrival
                            ? new Date(stop.estimatedArrival).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })
                            : 'N/A'}
                        </strong>
                      </div>

                      <div>
                        <span className="text-slate-400 block text-[10px]">Service Window</span>
                        <strong className="text-slate-800">
                          {stop.estimatedServiceStart && stop.estimatedServiceEnd
                            ? `${new Date(stop.estimatedServiceStart).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })} - ${new Date(stop.estimatedServiceEnd).toLocaleTimeString([], {
                                hour: '2-digit',
                                minute: '2-digit',
                              })}`
                            : 'N/A'}
                        </strong>
                      </div>

                      {stop.estimatedTravelFromPrevious && (
                        <div>
                          <span className="text-slate-400 block text-[10px]">Leg Road Distance</span>
                          <span className="text-slate-700 font-medium">
                            {stop.estimatedTravelFromPrevious.distanceKm} km (
                            {stop.estimatedTravelFromPrevious.durationMinutes} mins)
                          </span>
                        </div>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          </div>
        ) : (
          <EmptyState
            title="Route Data Unavailable"
            message="No routing data could be generated for this job."
          />
        )}
      </Modal>

      {/* 6. Job Full Details Modal */}
      <Modal
        isOpen={detailsModalOpen}
        onClose={() => setDetailsModalOpen(false)}
        title={
          selectedJob?.jobType === 'pool'
            ? 'Service Pool Assignment Details'
            : 'Individual Booking Assignment Details'
        }
        maxWidth="max-w-2xl"
      >
        {selectedJob && (
          <div className="space-y-4 text-xs">
            {/* Header info */}
            <div className="flex items-center justify-between p-3 rounded-xl bg-slate-50 border border-slate-200">
              <div>
                <span className="text-slate-400 text-[10px] block">Service Category</span>
                <span className="font-bold text-slate-800 text-sm">
                  {selectedJob.specificService || selectedJob.serviceCategory?.name}
                </span>
              </div>
              <StatusBadge status={selectedJob.status} />
            </div>

            {/* Pooled members breakdown */}
            {selectedJob.jobType === 'pool' && selectedJob.members && (
              <div className="space-y-2">
                <h4 className="font-bold text-slate-800">
                  Pool Members ({selectedJob.members.length} Active Customers)
                </h4>
                <div className="space-y-2">
                  {selectedJob.status === 'completed' && <p>Completed visit fares · ₹{selectedJob.members.reduce((sum,m) => sum + (m.earned || 0), 0).toFixed(2)}</p>}
                  {selectedJob.members.slice().sort((a,b) => a.memberIndex - b.memberIndex).map((m, idx) => (
                    <div
                      key={m.bookingId || idx}
                      className="p-3 rounded-xl border border-slate-200 bg-white space-y-1"
                    >
                      <div className="flex items-center justify-between">
                        <span className="font-bold text-slate-800">
                          Stop #{m.memberIndex}: {m.customer?.name || 'Customer'}
                        </span>
                        {m.customer?.phone && (
                          <a
                            href={`tel:${m.customer.phone}`}
                            className="text-indigo-600 hover:underline flex items-center gap-1 font-semibold"
                          >
                            <Phone className="w-3 h-3" />
                            {m.customer.phone}
                          </a>
                        )}
                      </div>
                      <p className="text-slate-500 text-[11px]">
                        Address: {m.addressText || 'Customer service address'}
                      </p>
                      {selectedJob.status === 'completed' && <p>Visit fare earned · ₹{(m.earned || 0).toFixed(2)}</p>}
                      {m.notes && (
                        <p className="text-slate-600 bg-slate-50 p-2 rounded-lg text-[11px] italic">
                          Notes: &ldquo;{m.notes}&rdquo;
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Individual booking contact details */}
            {selectedJob.jobType === 'individual' && (
              <div className="space-y-3 p-3.5 rounded-xl border border-slate-200 bg-white">
                <h4 className="font-bold text-slate-800">Customer & Location</h4>
                <div className="grid grid-cols-2 gap-2 text-[11px]">
                  <div>
                    <span className="text-slate-400 block">Customer Name</span>
                    <strong className="text-slate-800">{selectedJob.customer?.name}</strong>
                  </div>
                  <div>
                    <span className="text-slate-400 block">Phone</span>
                    {selectedJob.customer?.phone ? (
                      <a href={`tel:${selectedJob.customer.phone}`} className="text-indigo-600 font-bold">
                        {selectedJob.customer.phone}
                      </a>
                    ) : (
                      'N/A'
                    )}
                  </div>
                  <div className="col-span-2">
                    <span className="text-slate-400 block">Address</span>
                    <span className="text-slate-800">{selectedJob.addressText}</span>
                  </div>
                  {selectedJob.notes && (
                    <div className="col-span-2 bg-slate-50 p-2 rounded-lg italic">
                      Notes: &ldquo;{selectedJob.notes}&rdquo;
                    </div>
                  )}
                </div>
              </div>
            )}

            {/* Pricing and Timestamps */}
            <div className="p-3.5 rounded-xl bg-slate-50 border border-slate-200 grid grid-cols-2 gap-2 text-[11px]">
              <div>
                <span className="text-slate-400 block">Assigned At</span>
                <span>
                  {selectedJob.assignedAt ? new Date(selectedJob.assignedAt).toLocaleString() : 'N/A'}
                </span>
              </div>
              <div>
                <span className="text-slate-400 block">Accepted At</span>
                <span>
                  {selectedJob.acceptedAt ? new Date(selectedJob.acceptedAt).toLocaleString() : 'Pending'}
                </span>
              </div>
              <div>
                <span className="text-slate-400 block">Started At</span>
                <span>
                  {selectedJob.startedAt ? new Date(selectedJob.startedAt).toLocaleString() : 'Not started'}
                </span>
              </div>
              <div>
                <span className="text-slate-400 block">Completed At</span>
                <span>
                  {selectedJob.completedAt ? new Date(selectedJob.completedAt).toLocaleString() : 'Pending'}
                </span>
              </div>
            </div>

            {/* Modal Actions */}
            <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
              <button
                type="button"
                onClick={() => setDetailsModalOpen(false)}
                className="px-4 py-2 rounded-xl text-xs font-semibold text-slate-600 hover:bg-slate-100"
              >
                Close
              </button>
            </div>
          </div>
        )}
      </Modal>

      {/* 7. Rejection Reason Confirmation Modal */}
      <Modal
        isOpen={rejectModalOpen}
        onClose={() => setRejectModalOpen(false)}
        title="Reject Job Assignment"
      >
        <div className="space-y-4 text-xs">
          <p className="text-slate-600 leading-relaxed">
            Please provide a reason for rejecting this assignment. The pool or booking will be immediately released back into the dispatch queue for another eligible technician.
          </p>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Rejection Reason
            </label>
            <textarea
              rows={3}
              required
              value={rejectionReason}
              onChange={(e) => setRejectionReason(e.target.value)}
              placeholder="e.g., Unforeseen scheduling conflict or vehicle issue..."
              className="glass-input w-full p-2.5 text-xs"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setRejectModalOpen(false)}
              className="px-4 py-2 rounded-xl text-xs font-medium text-slate-600 hover:bg-slate-100"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={Boolean(processingJobs[jobToReject?._id])}
              onClick={handleConfirmReject}
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-rose-600 hover:bg-rose-700 text-white shadow-xs disabled:opacity-50"
            >
              {processingJobs[jobToReject?._id] ? 'Rejecting...' : 'Confirm Rejection'}
            </button>
          </div>
        </div>
      </Modal>

      {/* 8. Cancellation Reason Confirmation Modal */}
      <Modal
        isOpen={cancelModalOpen}
        onClose={() => setCancelModalOpen(false)}
        title="Cancel Active Job"
      >
        <div className="space-y-4 text-xs">
          <p className="text-slate-600 leading-relaxed">
            Cancelling an active job will notify customer(s) and update your workload status. A valid explanation is mandatory.
          </p>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Cancellation Reason <span className="text-rose-500">*</span>
            </label>
            <textarea
              rows={3}
              required
              value={cancellationReason}
              onChange={(e) => setCancellationReason(e.target.value)}
              placeholder="State reason for cancellation..."
              className="glass-input w-full p-2.5 text-xs"
            />
          </div>

          <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
            <button
              type="button"
              onClick={() => setCancelModalOpen(false)}
              className="px-4 py-2 rounded-xl text-xs font-medium text-slate-600 hover:bg-slate-100"
            >
              Abort
            </button>
            <button
              type="button"
              disabled={Boolean(processingJobs[jobToCancel?._id]) || !cancellationReason.trim()}
              onClick={handleConfirmCancel}
              className="px-4 py-2 rounded-xl text-xs font-semibold bg-rose-600 hover:bg-rose-700 text-white shadow-xs disabled:opacity-50"
            >
              {processingJobs[jobToCancel?._id] ? 'Cancelling...' : 'Confirm Cancellation'}
            </button>
          </div>
        </div>
      </Modal>
    </div>
  );
}