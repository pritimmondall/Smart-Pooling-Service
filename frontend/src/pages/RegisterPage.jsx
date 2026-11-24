import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { Sparkles, ArrowRight, Lock, Mail, User, Phone, AlertCircle, Wrench } from 'lucide-react';
import LocationPickerMap from '../components/common/LocationPickerMap.jsx';
import { useAuth } from '../context/AuthContext.jsx';

export default function RegisterPage() {
  const { register } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();

  const [role, setRole] = useState('customer');
  const [baseLocation, setBaseLocation] = useState(null);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    password: '',
    confirmPassword: '',
  });
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const handleChange = (e) => {
    setFormData((prev) => ({ ...prev, [e.target.name]: e.target.value }));
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    if (formData.password.length < 6) {
      setError('Password must be at least 6 characters long.');
      return;
    }

    if (formData.password !== formData.confirmPassword) {
      setError('Passwords do not match.');
      return;
    }

    if (role === 'technician' && !baseLocation) {
      setError('Select your work location on the map or choose a quick zone.');
      return;
    }

    try {
      setLoading(true);
      await register({
        role,
        ...(role === 'technician' ? { baseLocation } : {}),
        name: formData.name.trim(),
        email: formData.email.trim().toLowerCase(),
        phone: formData.phone.trim(),
        password: formData.password,
      });
      navigate(role === 'technician' ? '/technician/profile-setup' : location.state?.from || '/', { replace: true });
    } catch (err) {
      setError(err.message || 'Registration failed. Please check your information.');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 sm:p-6 bg-[#f8fafc]">
      <div className="w-full max-w-md">
        {/* Brand Header */}
        <div className="text-center mb-8">
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-emerald-600 text-white shadow-lg shadow-emerald-600/30 mb-3">
            <Sparkles className="w-6 h-6 stroke-[2]" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">
            Create your account
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Choose how you’ll use SmartPool.
          </p>
        </div>

        {/* Card */}
        <div className="glass-panel bg-white/85 rounded-3xl p-6 sm:p-8 shadow-xl border border-slate-200/80">
          {error && (
            <div role="alert" className="mb-5 p-3 rounded-xl bg-rose-50 border border-rose-200/80 text-rose-700 text-xs flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <fieldset disabled={loading}>
              <legend className="text-xs font-semibold text-slate-700 mb-2">Account type</legend>
              <div className="grid grid-cols-2 gap-2">
                {[
                  { value: 'customer', label: 'Customer', detail: 'Book home services', icon: User },
                  { value: 'technician', label: 'Technician', detail: 'Provide services', icon: Wrench },
                ].map(({ value, label, detail, icon: Icon }) => (
                  <label key={value} className={`rounded-xl border p-3 cursor-pointer focus-within:ring-2 focus-within:ring-emerald-600 ${role === value
                    ? 'border-emerald-600 bg-emerald-50 text-emerald-900' : 'border-slate-200 bg-white text-slate-700'}`}>
                    <span className="flex justify-between items-center"><Icon size={17}/>
                      <input type="radio" name="role" value={value} checked={role === value} className="accent-emerald-700"
                        onChange={() => { setRole(value); setError(null); }}/>
                    </span>
                    <strong className="block text-sm mt-2">{label}</strong>
                    <span className="text-xs">{detail}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Full Name
              </label>
              <div className="relative">
                <User className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                <input
                  type="text"
                  name="name"
                  required
                  placeholder="e.g. Priyanshu Sen"
                  value={formData.name}
                  onChange={handleChange}
                  className="glass-input w-full pl-10"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Email Address
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                <input
                  type="email"
                  name="email"
                  required
                  placeholder="name@example.com"
                  value={formData.email}
                  onChange={handleChange}
                  className="glass-input w-full pl-10"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Phone Number
              </label>
              <div className="relative">
                <Phone className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                <input
                  type="tel"
                  name="phone"
                  placeholder="+91-9876543210"
                  value={formData.phone}
                  onChange={handleChange}
                  className="glass-input w-full pl-10"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Password
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                <input
                  type="password"
                  name="password"
                  required
                  placeholder="At least 6 characters"
                  value={formData.password}
                  onChange={handleChange}
                  className="glass-input w-full pl-10"
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Confirm Password
              </label>
              <div className="relative">
                <Lock className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                <input
                  type="password"
                  name="confirmPassword"
                  required
                  placeholder="Confirm password"
                  value={formData.confirmPassword}
                  onChange={handleChange}
                  className="glass-input w-full pl-10"
                />
              </div>
            </div>

            {role === 'technician' && <fieldset className="space-y-2">
              <legend className="text-sm font-semibold text-slate-800">Work location</legend>
              <p className="text-xs text-slate-600">Select your base on the map or choose a quick zone. Next, choose your service fields and working hours. An admin must approve your account before you can claim work.</p>
              <LocationPickerMap value={baseLocation} onChange={setBaseLocation} height="200px"/>
            </fieldset>}

            <button
              type="submit"
              disabled={loading}
              className="glass-button-primary w-full mt-2 py-3 text-sm font-semibold"
            >
              {loading ? 'Creating Account...' : 'Complete Registration'}
              {!loading && <ArrowRight className="w-4 h-4" />}
            </button>
          </form>
        </div>

        {/* Footer Link */}
        <p className="text-center text-xs text-slate-500 mt-6">
          Already registered?{' '}
          <Link state={location.state} to="/login" className="font-semibold text-emerald-700 hover:text-emerald-800">
            Sign in
          </Link>
        </p>
      </div>
    </div>
  );
}
