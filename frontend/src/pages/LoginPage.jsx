import React, { useState } from 'react';
import { Link, useNavigate, useLocation } from 'react-router-dom';
import { Sparkles, ArrowRight, Lock, Mail, AlertCircle } from 'lucide-react';
import { useAuth } from '../context/AuthContext.jsx';

export default function LoginPage() {
  const { login, authError } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(false);

  const from = location.state?.from?.pathname || '/';

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError(null);

    if (!email || !password) {
      setError('Please provide both email and password.');
      return;
    }

    try {
      setLoading(true);
      await login(email, password);
      navigate(from, { replace: true });
    } catch (err) {
      setError(err.message || 'Login failed. Please verify your credentials.');
    } finally {
      setLoading(false);
    }
  };

  const fillDemoAccount = (demoEmail, demoPass) => {
    setEmail(demoEmail);
    setPassword(demoPass);
    setError(null);
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
            Welcome to SmartPool
          </h1>
          <p className="text-xs text-slate-500 mt-1">
            Sign in to access your SmartPool dashboard
          </p>
        </div>

        {/* Card */}
        <div className="glass-panel bg-white/85 rounded-3xl p-6 sm:p-8 shadow-xl border border-slate-200/80">
          {(error || authError) && (
            <div className="mb-5 p-3 rounded-xl bg-rose-50 border border-rose-200/80 text-rose-700 text-xs flex items-start gap-2.5">
              <AlertCircle className="w-4 h-4 text-rose-500 shrink-0 mt-0.5" />
              <span>{error || authError}</span>
            </div>
          )}

          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1.5">
                Email Address
              </label>
              <div className="relative">
                <Mail className="w-4 h-4 text-slate-400 absolute left-3.5 top-3" />
                <input
                  type="email"
                  required
                  placeholder="name@example.com"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
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
                  required
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  className="glass-input w-full pl-10"
                />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="glass-button-primary w-full mt-2 py-3 text-sm font-semibold"
            >
              {loading ? 'Authenticating...' : 'Sign In'}
              {!loading && <ArrowRight className="w-4 h-4" />}
            </button>
          </form>

          {/* Seed Demo Quick-Select */}
          <div className="mt-6 pt-6 border-t border-slate-100">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 text-center mb-2.5">
              Quick Test: Seeded Demo Accounts
            </p>
            <div className="grid grid-cols-2 gap-2 mb-2">
              <button
                type="button"
                onClick={() => fillDemoAccount('tech.ac@smartpool.demo', 'TechDemo123!')}
                className="p-2 text-left rounded-xl border border-indigo-200/80 bg-indigo-50/50 hover:bg-indigo-100 hover:border-indigo-300 text-slate-700 transition-all text-xs"
              >
                <span className="font-semibold block truncate text-indigo-900">Rohit (Technician)</span>
                <span className="text-[10px] text-indigo-600 block truncate">AC / Appliance</span>
              </button>
              <button
                type="button"
                onClick={() => fillDemoAccount('tech.plumbing@smartpool.demo', 'TechDemo123!')}
                className="p-2 text-left rounded-xl border border-indigo-200/80 bg-indigo-50/50 hover:bg-indigo-100 hover:border-indigo-300 text-slate-700 transition-all text-xs"
              >
                <span className="font-semibold block truncate text-indigo-900">Manoj (Technician)</span>
                <span className="text-[10px] text-indigo-600 block truncate">Plumbing</span>
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => fillDemoAccount('customer1@smartpool.demo', 'CustomerDemo123!')}
                className="p-2 text-left rounded-xl border border-slate-200/80 bg-slate-50/70 hover:bg-emerald-50 hover:border-emerald-200 text-slate-700 transition-all text-xs"
              >
                <span className="font-semibold block truncate">Aarav (Customer)</span>
                <span className="text-[10px] text-slate-400 block truncate">customer1</span>
              </button>
              <button
                type="button"
                onClick={() => fillDemoAccount('customer2@smartpool.demo', 'CustomerDemo123!')}
                className="p-2 text-left rounded-xl border border-slate-200/80 bg-slate-50/70 hover:bg-emerald-50 hover:border-emerald-200 text-slate-700 transition-all text-xs"
              >
                <span className="font-semibold block truncate">Riya (Customer)</span>
                <span className="text-[10px] text-slate-400 block truncate">customer2</span>
              </button>
            </div>
          </div>
        </div>

        {/* Footer Link */}
        <p className="text-center text-xs text-slate-500 mt-6">
          Don&apos;t have an account?{' '}
          <Link to="/register" className="font-semibold text-emerald-700 hover:text-emerald-800">
            Create an account
          </Link>
        </p>
      </div>
    </div>
  );
}
