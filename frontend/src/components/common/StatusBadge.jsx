import React from 'react';

const STATUS_CONFIG = {
  pending: {
    label: 'Pending Matching',
    bg: 'bg-amber-50 text-amber-700 border-amber-200/60',
    dot: 'bg-amber-500',
  },
  confirmed: {
    label: 'Confirmed',
    bg: 'bg-blue-50 text-blue-700 border-blue-200/60',
    dot: 'bg-blue-500',
  },
  assigned: {
    label: 'Technician Assigned',
    bg: 'bg-indigo-50 text-indigo-700 border-indigo-200/60',
    dot: 'bg-indigo-500',
  },
  accepted: {
    label: 'Accepted',
    bg: 'bg-teal-50 text-teal-700 border-teal-200/60',
    dot: 'bg-teal-500',
  },
  in_progress: {
    label: 'In Progress',
    bg: 'bg-emerald-50 text-emerald-700 border-emerald-200/60',
    dot: 'bg-emerald-500 animate-pulse',
  },
  completed: {
    label: 'Completed',
    bg: 'bg-slate-100 text-slate-700 border-slate-200',
    dot: 'bg-slate-400',
  },
  cancelled: {
    label: 'Cancelled',
    bg: 'bg-rose-50 text-rose-700 border-rose-200/60',
    dot: 'bg-rose-500',
  },
};

export default function StatusBadge({ status, className = '' }) {
  const config = STATUS_CONFIG[status] || {
    label: status || 'Unknown',
    bg: 'bg-slate-100 text-slate-700 border-slate-200',
    dot: 'bg-slate-400',
  };

  return (
    <span
      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium border ${config.bg} ${className}`}
    >
      <span className={`w-1.5 h-1.5 rounded-full ${config.dot}`} />
      {config.label}
    </span>
  );
}
