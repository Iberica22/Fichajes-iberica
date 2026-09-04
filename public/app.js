const gps = document.getElementById('gps');
const lat = document.getElementById('latitude');
const lon = document.getElementById('longitude');
const acc = document.getElementById('accuracy');
const form = document.getElementById('punchForm');
const employeeSelect = document.getElementById('employeeId');
const stateText = document.getElementById('stateText');
const buttons = [...document.querySelectorAll('button[name="kind"]')];
const storageKey = 'fichaje-iberica-employee-id';
let gpsReady = false;
let allowedKinds = buttons.filter(button => !button.disabled).map(button => button.value);

buttons.forEach(button => { button.dataset.label = button.textContent; });

function setButtons(enabled) {
  buttons.forEach(button => {
    const blockedByState = !allowedKinds.includes(button.value);
    button.disabled = !enabled || blockedByState;
    button.textContent = !enabled && !blockedByState ? 'Esperando GPS…' : button.dataset.label;
  });
}

async function refreshState() {
  if (!employeeSelect?.value) return;
  try {
    const response = await fetch(`/state/${encodeURIComponent(employeeSelect.value)}`);
    const data = await response.json();
    allowedKinds = data.allowed || ['entrada'];
    if (stateText) stateText.textContent = data.label || data.state || 'fuera';
    setButtons(gpsReady);
  } catch {
    if (stateText) stateText.textContent = 'sin conexión';
  }
}

if (employeeSelect) {
  const params = new URLSearchParams(window.location.search);
  const saved = params.get('employee') || localStorage.getItem(storageKey);
  if (saved && [...employeeSelect.options].some(option => option.value === saved)) employeeSelect.value = saved;
  employeeSelect.addEventListener('change', () => {
    localStorage.setItem(storageKey, employeeSelect.value);
    refreshState();
  });
  localStorage.setItem(storageKey, employeeSelect.value);
}

function validCoords() {
  const latitude = Number(lat.value);
  const longitude = Number(lon.value);
  return Number.isFinite(latitude) && Number.isFinite(longitude)
    && !(Math.abs(latitude) < 0.0001 && Math.abs(longitude) < 0.0001);
}

form?.addEventListener('submit', event => {
  if (employeeSelect) localStorage.setItem(storageKey, employeeSelect.value);
  if (!validCoords()) {
    event.preventDefault();
    gps.textContent = 'No se ha obtenido una ubicación válida. Activa la ubicación precisa, permite el acceso y vuelve a intentarlo.';
    gps.className = 'status warning';
  }
});

setButtons(false);
refreshState();

if (!navigator.geolocation) {
  gps.textContent = 'Este navegador no permite obtener la ubicación. Abre el enlace en Chrome o Safari.';
  gps.className = 'status warning';
} else {
  gps.textContent = 'Solicitando ubicación…';
  navigator.geolocation.getCurrentPosition(
    position => {
      lat.value = position.coords.latitude;
      lon.value = position.coords.longitude;
      acc.value = position.coords.accuracy || '';
      gpsReady = validCoords();
      gps.textContent = gpsReady
        ? `Ubicación lista · precisión aproximada ${Math.round(position.coords.accuracy || 0)} m`
        : 'El dispositivo no ha devuelto una ubicación válida.';
      gps.className = gpsReady ? 'status success' : 'status warning';
      setButtons(gpsReady);
    },
    error => {
      const denied = error.code === error.PERMISSION_DENIED;
      gps.textContent = denied
        ? 'Permiso de ubicación denegado. Actívalo para esta página en los ajustes del navegador y recarga.'
        : 'No se ha podido obtener la ubicación. Comprueba que el GPS está activo y vuelve a intentarlo.';
      gps.className = 'status warning';
      gpsReady = false;
      setButtons(false);
    },
    { enableHighAccuracy: true, timeout: 20000, maximumAge: 0 }
  );
}
