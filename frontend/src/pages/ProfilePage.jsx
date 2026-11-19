import React, { useState } from 'react';
import { User, Mail, Phone, ShieldCheck, CheckCircle2, AlertCircle, Save, LogOut } from 'lucide-react';
import LocationPickerMap from '../components/common/LocationPickerMap.jsx';
import { useAuth } from '../context/AuthContext.jsx';
import { useNavigate } from 'react-router-dom';

export default function ProfilePage() {
  const { user, updateProfile, logout } = useAuth();
  const navigate = useNavigate();

  const [name, setName] = useState(user?.name || '');
  const [phone, setPhone] = useState(user?.phone || '');
  const [alertLocation, setAlertLocation] = useState(user?.poolAlertLocation || null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [success, setSuccess] = useState(null);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);
    setSuccess(null);

    if (!name.trim()) {
      setError('Name cannot be empty.');
      return;
    }

    try {
      setSaving(true);
      await updateProfile({
        ...(alertLocation ? { poolAlertLocation: alertLocation } : {}),
        name: name.trim(),
        phone: phone.trim(),
      });
      setSuccess('Profile details updated successfully.');
    } catch (err) {
      setError(err.message || 'Failed to update profile.');
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="max-w-2xl mx-auto space-y-6">
      {/* Header */}
      <div className="pb-2 border-b border-slate-200/80">
        <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-slate-900 flex items-center gap-2">
          <User className="w-6 h-6 text-emerald-600" />
          Account Profile & Settings
        </h1>
        <p className="text-xs sm:text-sm text-slate-500 mt-1">
          Manage your personal customer profile and contact details
        </p>
      </div>

      {success && (
        <div className="p-3.5 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 text-xs flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-600" />
          <span>{success}</span>
        </div>
      )}

      {error && (
        <div className="p-4 rounded-2xl bg-rose-50 border border-rose-200 text-rose-700 text-xs flex items-center gap-3">
          <AlertCircle className="w-4 h-4 text-rose-500 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Profile Form Card */}
      <div className="glass-panel rounded-3xl p-6 sm:p-8 border border-slate-200/80 space-y-6">
        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Full Name
            </label>
            <div className="relative">
              <User className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="glass-input w-full pl-10 text-xs"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Email Address (Read-only)
            </label>
            <div className="relative">
              <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
              <input
                type="email"
                readOnly
                disabled
                value={user?.email || ''}
                className="glass-input w-full pl-10 text-xs bg-slate-100/70 text-slate-500 cursor-not-allowed"
              />
            </div>
            <p className="text-[10px] text-slate-400 mt-1">
              Email address is linked to your primary login credentials and cannot be modified here.
            </p>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1.5">
              Contact Phone Number
            </label>
            <div className="relative">
              <Phone className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
              <input
                type="tel"
                placeholder="+91-9876543210"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                className="glass-input w-full pl-10 text-xs"
              />
            </div>
          </div>

          {user?.role === 'customer' && <section className="space-y-2">
            <h2 className="text-sm font-semibold">Nearby pool alerts</h2>
            <p className="text-xs text-slate-600">Choose a location to receive invitations within 200 m, then save your changes. Your first booking sets this location if you leave it empty.</p>
            <LocationPickerMap value={alertLocation} onChange={setAlertLocation} height="220px" />
          </section>}
          <div className="pt-2">
            <button
              type="submit"
              disabled={saving}
              className="glass-button-primary text-xs px-5 py-2.5 font-semibold"
            >
              <Save className="w-3.5 h-3.5" />
              {saving ? 'Saving...' : 'Save Profile Changes'}
            </button>
          </div>
        </form>
      </div>

      {/* Account Status Card */}
      <div className="glass-panel rounded-3xl p-6 border border-slate-200/80 space-y-4">
        <h2 className="text-sm font-bold text-slate-900 pb-2 border-b border-slate-100 flex items-center gap-2">
          <ShieldCheck className="w-4 h-4 text-emerald-600" />
          Account & Role Details
        </h2>

        <div className="grid grid-cols-2 gap-4 text-xs">
          <div>
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
              Platform Role
            </span>
            <span className="font-semibold text-slate-800 capitalize mt-0.5 block">
              {user?.role || 'Customer'}
            </span>
          </div>
          <div>
            <span className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider block">
              Account Status
            </span>
            <span className="inline-flex items-center gap-1.5 mt-0.5 text-emerald-700 font-semibold">
              <span className="w-2 h-2 rounded-full bg-emerald-500" />
              Active
            </span>
          </div>
        </div>

        <div className="pt-4 border-t border-slate-100 flex justify-between items-center">
          <span className="text-xs text-slate-500">Sign out of this session:</span>
          <button
            type="button"
            onClick={handleLogout}
            className="glass-button-secondary text-xs px-4 py-2 text-rose-600 hover:text-rose-700 border-rose-200 hover:bg-rose-50 font-medium"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign Out
          </button>
        </div>
      </div>
    </div>
  );
}
