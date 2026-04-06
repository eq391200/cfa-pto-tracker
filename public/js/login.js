let loginRole = null;

document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('error');
  errorEl.style.display = 'none';

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Signing in\u2026';

  const username = document.getElementById('username').value;
  const password = document.getElementById('password').value;

  try {
    const res = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });

    const data = await res.json();

    if (data.success) {
      if (data.mustChangePassword) {
        // Show the set-password form
        loginRole = data.role;
        document.getElementById('loginForm').style.display = 'none';
        document.getElementById('setPasswordForm').style.display = '';
        document.getElementById('newPassword').focus();
        btn.disabled = false;
        btn.textContent = 'Sign In';
      } else {
        window.location.href = data.role === 'admin' ? '/index.html' : '/employee.html';
      }
    } else {
      errorEl.textContent = data.error || 'Login failed';
      errorEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Sign In';
    }
  } catch (err) {
    errorEl.textContent = 'Connection error. Please try again.';
    errorEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Sign In';
  }
});

document.getElementById('setPasswordForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const errorEl = document.getElementById('setError');
  errorEl.style.display = 'none';

  const newPassword = document.getElementById('newPassword').value;
  const confirmPassword = document.getElementById('confirmPassword').value;

  if (newPassword.length < 6) {
    errorEl.textContent = 'Password must be at least 6 characters.';
    errorEl.style.display = 'block';
    return;
  }

  if (newPassword !== confirmPassword) {
    errorEl.textContent = 'Passwords do not match.';
    errorEl.style.display = 'block';
    return;
  }

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Setting password\u2026';

  try {
    const res = await fetch('/api/auth/set-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ newPassword })
    });

    const data = await res.json();

    if (data.success) {
      window.location.href = data.role === 'admin' ? '/index.html' : '/employee.html';
    } else {
      errorEl.textContent = data.error || 'Failed to set password.';
      errorEl.style.display = 'block';
      btn.disabled = false;
      btn.textContent = 'Set Password';
    }
  } catch (err) {
    errorEl.textContent = 'Connection error. Please try again.';
    errorEl.style.display = 'block';
    btn.disabled = false;
    btn.textContent = 'Set Password';
  }
});

// ── Forgot Password Flow ──────────────────────────────────────────
document.getElementById('forgotPasswordLink').addEventListener('click', function(e) {
  e.preventDefault();
  document.getElementById('loginForm').style.display = 'none';
  document.getElementById('resetForm').style.display = '';
  document.getElementById('resetPin').focus();
});

document.getElementById('backToLoginLink').addEventListener('click', function(e) {
  e.preventDefault();
  document.getElementById('resetForm').style.display = 'none';
  document.getElementById('resetError').style.display = 'none';
  document.getElementById('resetSuccess').style.display = 'none';
  document.getElementById('loginForm').style.display = '';
});

document.getElementById('resetForm').addEventListener('submit', async function(e) {
  e.preventDefault();
  var errorEl = document.getElementById('resetError');
  var successEl = document.getElementById('resetSuccess');
  errorEl.style.display = 'none';
  successEl.style.display = 'none';

  var pin = document.getElementById('resetPin').value.trim();
  if (!pin) {
    errorEl.textContent = 'Please enter your PIN.';
    errorEl.style.display = 'block';
    return;
  }

  var btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  btn.textContent = 'Resetting\u2026';

  try {
    var res = await fetch('/api/auth/reset-to-pin', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: pin })
    });

    var data = await res.json();

    if (data.success) {
      successEl.textContent = 'Password reset! You can now log in using your PIN as both username and password.';
      successEl.style.display = 'block';
      btn.textContent = 'Reset Password';
      btn.disabled = false;
    } else {
      errorEl.textContent = data.error || 'Failed to reset password.';
      errorEl.style.display = 'block';
      btn.textContent = 'Reset Password';
      btn.disabled = false;
    }
  } catch (err) {
    errorEl.textContent = 'Connection error. Please try again.';
    errorEl.style.display = 'block';
    btn.textContent = 'Reset Password';
    btn.disabled = false;
  }
});
