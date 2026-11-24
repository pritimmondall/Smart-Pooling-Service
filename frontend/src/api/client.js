const rawBaseUrl = import.meta.env?.VITE_API_BASE_URL;
const normalizeBaseUrl = (url) => {
  if (!url) return '/api/v1';
  const trimmed = url.replace(/\/+$/, '');
  return trimmed.endsWith('/api/v1') ? trimmed : `${trimmed}/api/v1`;
};
const BASE_URL = normalizeBaseUrl(rawBaseUrl);

export class ApiError extends Error {
  constructor(message, code = 'API_ERROR', status = 500, details = undefined) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function request(endpoint, options = {}) {
  const token = typeof localStorage !== 'undefined' ? localStorage.getItem('smartpool_token') : null;
  const headers = {
    'Content-Type': 'application/json',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...options.headers,
  };

  const config = {
    ...options,
    headers,
  };

  if (config.body && typeof config.body === 'object' && !(config.body instanceof FormData)) {
    config.body = JSON.stringify(config.body);
  }

  let response;
  try {
    response = await fetch(`${BASE_URL}${endpoint}`, config);
  } catch (networkError) {
    throw new ApiError('Unable to connect to server. Please check your network or try again.', 'NETWORK_ERROR', 0);
  }

  let json = null;
  const text = await response.text();
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }

  if (!response.ok) {
    const errorData = json?.error || {};
    const message = errorData.message || response.statusText || 'Request failed';
    const code = errorData.code || 'REQUEST_FAILED';
    const details = errorData.details;

    if (response.status === 401) {
      window.dispatchEvent(new CustomEvent('smartpool:unauthorized'));
    }

    throw new ApiError(message, code, response.status, details);
  }

  return json;
}

export const api = {
  get: (endpoint, options) => request(endpoint, { method: 'GET', ...options }),
  post: (endpoint, body, options) => request(endpoint, { method: 'POST', body, ...options }),
  patch: (endpoint, body, options) => request(endpoint, { method: 'PATCH', body, ...options }),
  delete: (endpoint, options) => request(endpoint, { method: 'DELETE', ...options }),
};

// Auth API
export const authApi = {
  login: (email, password) => api.post('/auth/login', { email, password }),
  register: (data) => api.post('/auth/register', data),
  getMe: () => api.get('/auth/me'),
};

// User Profile API
export const userApi = {
  getProfile: () => api.get('/users/me'),
  updateProfile: (data) => api.patch('/users/me', data),
};

// Services Catalog API
export const servicesApi = {
  listActive: () => api.get('/services'),
  getById: (id) => api.get(`/services/${id}`),
};

// Service Zones API
export const zonesApi = {
  listActive: (params = {}) => {
    const search = new URLSearchParams();
    if (params.lat && params.lng) {
      search.set('lat', params.lat);
      search.set('lng', params.lng);
      if (params.radiusKm) search.set('radiusKm', params.radiusKm);
    }
    const query = search.toString();
    return api.get(`/zones${query ? `?${query}` : ''}`);
  },
  getById: (id) => api.get(`/zones/${id}`),
};

// Bookings API
export const bookingsApi = {
  watches: () => api.get('/bookings/watches'),
  watch: data => api.post('/bookings/watches', data),
  removeWatch: id => api.delete('/bookings/watches/' + id),
  dashboard: () => api.get('/bookings/dashboard'),
  quote: (data) => api.post('/bookings/quote', data),
  getRating: (id) => api.get(`/bookings/${id}/rating`),
  rate: (id, data) => api.post(`/bookings/${id}/rating`, data),
  confirm: (id) => api.post(`/bookings/${id}/confirm-completion`, {}),
  create: (data) => api.post('/bookings', data),
  getMyBookings: (params = {}) => {
    const search = new URLSearchParams();
    if (params.summary) search.set('summary', 'true');
    if (params.status) search.set('status', params.status);
    if (params.page) search.set('page', params.page);
    if (params.limit) search.set('limit', params.limit);
    const query = search.toString();
    return api.get(`/bookings/my${query ? `?${query}` : ''}`);
  },
  getById: (id) => api.get(`/bookings/${id}`),
  update: (id, data) => api.patch(`/bookings/${id}`, data),
  cancel: (id) => api.patch(`/bookings/${id}/cancel`),
};

// Pools API
export const poolsApi = {
  nearby: params => api.get(`/pools/nearby?${new URLSearchParams(params)}`),
  getMyPools: () => api.get('/pools/my'),
  getById: (id) => api.get(`/pools/${id}`),
};

// Notifications API
export const notificationsApi = {
  getMyNotifications: (params = {}) => {
    const search = new URLSearchParams();
    if (params.unreadOnly) search.set('unreadOnly', 'true');
    if (params.page) search.set('page', params.page);
    if (params.limit) search.set('limit', params.limit);
    const query = search.toString();
    return api.get(`/notifications/my${query ? `?${query}` : ''}`);
  },
  markAsRead: (id) => api.patch(`/notifications/${id}/read`),
};

// Technicians API
export const techniciansApi = {
  opportunities: () => api.get('/technicians/me/opportunities'),
  claim: (id, kind) => api.post(`/technicians/me/opportunities/${id}/claim`, { kind }),
  getEarnings: () => api.get('/technicians/me/earnings?timezone=' + encodeURIComponent(Intl.DateTimeFormat().resolvedOptions().timeZone)),
  activeRoutes: () => api.get('/technicians/me/routes'),
  replan: id => api.post(`/technicians/me/jobs/${id}/replan`),
  getMe: () => api.get('/technicians/me'),
  updateProfile: (data) => api.patch('/technicians/me/profile', data),
  updateAvailability: (data) => api.patch('/technicians/me/availability', data),
  getMyJobs: (params = {}) => {
    const search = new URLSearchParams();
    if (params.status) search.set('status', params.status);
    if (params.q) search.set('q', params.q);
    if (params.type) search.set('type', params.type);
    if (params.page) search.set('page', params.page);
    if (params.limit) search.set('limit', params.limit);
    const query = search.toString();
    return api.get(`/technicians/me/jobs${query ? `?${query}` : ''}`);
  },
  getJobById: (id) => api.get(`/technicians/me/jobs/${id}`),
  acceptJob: (id) => api.post(`/technicians/me/jobs/${id}/accept`),
  rejectJob: (id, reason) => api.post(`/technicians/me/jobs/${id}/reject`, { reason }),
  updateJobStatus: (id, status, reason) => api.patch(`/technicians/me/jobs/${id}/status`, { status, reason }),
  getJobRoute: (id, params = {}) => {
    const search = new URLSearchParams();
    if (params.lat && params.lng) {
      search.set('lat', params.lat);
      search.set('lng', params.lng);
    }
    const query = search.toString();
    return api.get(`/technicians/me/jobs/${id}/route${query ? `?${query}` : ''}`);
  },
  getJobStops: (jobId) => api.get(`/technicians/me/jobs/${jobId}/stops`),
  arriveJobStop: (jobId, stopId, data = {}) => api.post(`/technicians/me/jobs/${jobId}/stops/${stopId}/arrive`, data),
  startJobStop: (jobId, stopId) => api.post(`/technicians/me/jobs/${jobId}/stops/${stopId}/start`),
  completeJobStop: (jobId, stopId) => api.post(`/technicians/me/jobs/${jobId}/stops/${stopId}/complete`),
  cancelJobStop: (jobId, stopId, reason) => api.post(`/technicians/me/jobs/${jobId}/stops/${stopId}/cancel`, { reason }),
};
