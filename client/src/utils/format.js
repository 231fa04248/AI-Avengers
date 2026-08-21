export const priorityTone = { Critical: 'bg-rose-50 text-rose-700 ring-rose-100', High: 'bg-orange-50 text-orange-700 ring-orange-100', Medium: 'bg-amber-50 text-amber-700 ring-amber-100', Low: 'bg-emerald-50 text-emerald-700 ring-emerald-100' };
export const statusTone = { Submitted: 'bg-slate-100 text-slate-600', 'AI Processing': 'bg-violet-50 text-violet-700', Assigned: 'bg-sky-50 text-sky-700', 'In Progress': 'bg-blue-50 text-blue-700', Resolved: 'bg-emerald-50 text-emerald-700', Closed: 'bg-teal-50 text-teal-700', Escalated: 'bg-rose-50 text-rose-700', Rejected: 'bg-slate-100 text-slate-500' };
export const formatDate = (date, options = { month: 'short', day: 'numeric', year: 'numeric' }) => date ? new Intl.DateTimeFormat('en-IN', options).format(new Date(date)) : 'â€”';
export const formatTime = (date) => date ? new Intl.DateTimeFormat('en-IN', { hour: 'numeric', minute: '2-digit' }).format(new Date(date)) : 'â€”';
export const initials = (name = '') => name.split(' ').map((part) => part[0]).join('').slice(0, 2).toUpperCase();

