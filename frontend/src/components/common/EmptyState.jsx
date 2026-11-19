import React from 'react';
import { Inbox } from 'lucide-react';

export default function EmptyState({
  icon: Icon = Inbox,
  title = 'No items found',
  description = 'There is nothing to display here yet.',
  actionLabel,
  onAction,
  className = '',
}) {
  return (
    <div className={`glass-card rounded-2xl p-8 sm:p-12 text-center max-w-md mx-auto my-6 ${className}`}>
      <div className="w-12 h-12 rounded-2xl bg-slate-100 flex items-center justify-center mx-auto mb-4 text-slate-400">
        <Icon className="w-6 h-6 stroke-[1.5]" />
      </div>
      <h3 className="text-base font-semibold text-slate-800 mb-1">{title}</h3>
      <p className="text-sm text-slate-500 mb-6 leading-relaxed">{description}</p>
      {actionLabel && onAction && (
        <button
          type="button"
          onClick={onAction}
          className="glass-button-primary text-sm px-5 py-2.5 mx-auto"
        >
          {actionLabel}
        </button>
      )}
    </div>
  );
}
