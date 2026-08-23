// Points at the backend API. Change this if you deploy the backend elsewhere.
const API_BASE = window.API_BASE || 'http://localhost:4000/api';

const Auth = {
  getToken: () => localStorage.getItem('token'),
  getUser: () => JSON.parse(localStorage.getItem('user') || 'null'),
  setSession: (token, user) => {
    localStorage.setItem('token', token);
    localStorage.setItem('user', JSON.stringify(user));
  },
  clear: () => {
    localStorage.removeItem('token');
    localStorage.removeItem('user');
  },
  requireRole: (role) => {
    const user = Auth.getUser();
    if (!user || user.role !== role) {
      window.location.href = '/index.html';
    }
    return user;
  },
};

async function api(path, { method = 'GET', body, auth = true } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (auth) {
    const token = Auth.getToken();
    if (token) headers['Authorization'] = `Bearer ${token}`;
  }
  const res = await fetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data = null;
  try {
    data = await res.json();
  } catch (e) {
    /* no body */
  }
  if (!res.ok) {
    const message = (data && (data.error || (data.errors && data.errors[0]?.msg))) || `Request failed (${res.status})`;
    throw new Error(message);
  }
  return data;
}

function fmtDateTime(iso) {
  return new Date(iso).toLocaleString(undefined, {
    weekday: 'short', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  });
}

function fmtTime(iso) {
  return new Date(iso).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function logout() {
  Auth.clear();
  window.location.href = '/index.html';
}
