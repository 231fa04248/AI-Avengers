import axios from 'axios';

export const api = axios.create({ baseURL: import.meta.env.VITE_API_URL || 'http://localhost:5000/api' });
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('civicai_token');
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

export async function request(promise, fallback) {
  try { return (await promise()).data; } catch (error) { if (fallback !== undefined) return fallback; throw error; }
}

