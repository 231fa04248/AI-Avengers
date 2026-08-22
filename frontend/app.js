const cases = {
  drain: { id: 'CASE #CF-28419', title: 'Drainage overflow near Lakeview School', location: 'KR Puram · Lakeview School Gate, 8th Cross', status: 'Needs assignment', assigned: 'Unassigned', target: 'Today, 17:00', image: 'https://images.unsplash.com/photo-1523731407965-2430cd12f5e4?auto=format&fit=crop&w=900&q=80', text: 'Likely blocked storm drain causing water overflow onto a school access route. High pedestrian safety risk during morning arrivals.' },
  road: { id: 'CASE #CF-28416', title: 'Pothole cluster on 8th Main Road', location: 'Indiranagar · 8th Main Road, near Metro entrance', status: 'Assigned', assigned: 'Roads team B', target: 'Tomorrow, 12:00', image: 'https://images.unsplash.com/photo-1592244081795-7f3b7c83c55d?auto=format&fit=crop&w=900&q=80', text: 'Multiple road-surface failures along a high-traffic transit corridor. Grouped with four nearby reports and routed for patch repair.' },
  waste: { id: 'CASE #CF-28408', title: 'Missed waste collection at Cedar Block', location: 'Domlur · Cedar Block apartment approach', status: 'Needs assignment', assigned: 'Unassigned', target: 'Today, 18:30', image: 'https://images.unsplash.com/photo-1604187351574-c75ca79f5807?auto=format&fit=crop&w=900&q=80', text: 'Household waste has accumulated after a missed collection cycle. Escalated because of residential density and reported odor concerns.' },
  light: { id: 'CASE #CF-28389', title: 'Streetlights out along the park path', location: 'HAL 2nd Stage · Community park north path', status: 'Scheduled', assigned: 'Electrical team A', target: 'Tomorrow, 16:00', image: 'https://images.unsplash.com/photo-1534274988757-a28bf1a57c17?auto=format&fit=crop&w=900&q=80', text: 'Three consecutive lamps are offline along a public park path. Scheduled for electrical inspection during the next field round.' }
};
const get = (id) => document.getElementById(id);
document.querySelectorAll('.case-item').forEach((item) => item.addEventListener('click', () => {
  document.querySelectorAll('.case-item').forEach((caseItem) => caseItem.classList.remove('selected-case'));
  item.classList.add('selected-case');
  const data = cases[item.dataset.case];
  get('caseId').textContent = data.id; get('caseTitle').textContent = data.title; get('caseLocation').textContent = data.location;
  get('caseStatus').textContent = data.status; get('assigned').innerHTML = `${data.assigned}${data.assigned === 'Unassigned' ? ' <span class="assign">Assign →</span>' : ''}`;
  get('target').innerHTML = `${data.target} <span class="clock">●</span>`; get('caseImage').src = data.image; get('aiText').textContent = data.text;
  get('assignButton').innerHTML = `${data.assigned === 'Unassigned' ? 'Assign to response team' : 'Update case assignment'} <span>→</span>`;
}));
document.querySelectorAll('[data-filter]').forEach((button) => button.addEventListener('click', () => { document.querySelectorAll('[data-filter]').forEach((b) => b.classList.remove('selected')); button.classList.add('selected'); const filter = button.dataset.filter; document.querySelectorAll('.case-item').forEach((item) => { item.style.display = filter === 'All' || item.querySelector('.case-title span').textContent === filter.toUpperCase() ? 'flex' : 'none'; }); }));
const dialog = get('reportDialog'); get('newReport').addEventListener('click', () => dialog.showModal());
get('closeReport').addEventListener('click', () => dialog.close());
get('reportForm').addEventListener('submit', (event) => { event.preventDefault(); dialog.close(); const toast = get('toast'); toast.classList.add('show'); setTimeout(() => toast.classList.remove('show'), 3500); });
get('assignButton').addEventListener('click', () => { get('caseStatus').textContent = 'Assigned'; get('assigned').textContent = 'Drainage response team'; get('assignButton').innerHTML = 'Assigned to drainage response team <span>✓</span>'; });
