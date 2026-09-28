(function(){
  'use strict';

  /* ============================================================
     Helpers
     ============================================================ */
  function $(sel, root){ return (root||document).querySelector(sel); }
  function $all(sel, root){ return Array.from((root||document).querySelectorAll(sel)); }
  function escapeHtml(s){
    return String(s==null?'':s).replace(/[&<>"']/g, function(c){
      return {'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c];
    });
  }
  function pad2(n){ return String(n).padStart(2,'0'); }
  function isoToday(){
    var d = new Date();
    return d.getFullYear()+'-'+pad2(d.getMonth()+1)+'-'+pad2(d.getDate());
  }
  function isLeapYear(y){ return (y%4===0 && y%100!==0) || (y%400===0); }
  function daysInYear(y){ return isLeapYear(y) ? 366 : 365; }
  function daysInMonth(y,m){ return new Date(y, m, 0).getDate(); } // m = 1-12
  function parseISO(iso){
    var p = iso.split('-');
    return new Date(parseInt(p[0],10), parseInt(p[1],10)-1, parseInt(p[2],10));
  }
  function fmtISOToBR(iso){
    if(!iso) return '—';
    var p = iso.split('-');
    return p[2]+'/'+p[1]+'/'+p[0];
  }
  function daysBetweenInclusive(startISO, endISO){
    var a = parseISO(startISO), b = parseISO(endISO);
    return Math.round((b - a) / 86400000) + 1;
  }
  var MONTHS = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
  var DOW = ['Dom','Seg','Ter','Qua','Qui','Sex','Sáb'];
  var TYPE_LABEL = { ferias:'Férias', folga:'Folga', atestado:'Atestado', falta:'Falta' };
  var TYPE_PILL_CLASS = { ferias:'pill-ferias', folga:'pill-folga', atestado:'pill-atestado', falta:'pill-falta' };

  function initials(name){
    var parts = String(name||'').trim().split(/\s+/).filter(Boolean);
    if(!parts.length) return '?';
    if(parts.length===1) return parts[0].slice(0,2).toUpperCase();
    return (parts[0][0]+parts[parts.length-1][0]).toUpperCase();
  }

  /* ============================================================
     API helper
     ============================================================ */
  function api(method, url, body){
    var opts = {
      method: method,
      headers: {},
      credentials: 'same-origin'
    };
    if(body !== undefined){
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    return fetch(url, opts).then(function(res){
      return res.json().catch(function(){ return {}; }).then(function(data){
        if(!res.ok){
          var err = new Error((data && data.message) || 'Erro na requisição.');
          err.status = res.status;
          err.data = data;
          throw err;
        }
        return data;
      });
    });
  }

  /* ============================================================
     Toast
     ============================================================ */
  var toastTimer = null;
  function toast(msg, danger){
    var el = $('#toast');
    el.textContent = msg;
    el.classList.toggle('danger', !!danger);
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function(){ el.hidden = true; }, 3200);
  }

  /* ============================================================
     Modal
     ============================================================ */
  function openModal(html){
    $('#modalContent').innerHTML = html;
    $('#modalBackdrop').hidden = false;
  }
  function closeModal(){
    $('#modalBackdrop').hidden = true;
    $('#modalContent').innerHTML = '';
  }
  $('#modalBackdrop').addEventListener('click', function(e){
    if(e.target === $('#modalBackdrop')) closeModal();
  });

  function confirmModal(opts){
    return new Promise(function(resolve){
      var html = ''
        + '<div class="modal-title">' + escapeHtml(opts.title) + '</div>'
        + '<p style="font-size:13.5px; color:var(--text-muted); line-height:1.5; margin:0;">' + escapeHtml(opts.message) + '</p>'
        + '<div class="modal-actions">'
        + '  <button class="btn btn-ghost" id="cmCancel" type="button">Cancelar</button>'
        + '  <button class="btn ' + (opts.danger?'btn-danger':'btn-primary') + '" id="cmOk" type="button" style="width:auto;">' + escapeHtml(opts.confirmLabel||'Confirmar') + '</button>'
        + '</div>';
      openModal(html);
      $('#cmCancel').addEventListener('click', function(){ closeModal(); resolve(false); });
      $('#cmOk').addEventListener('click', function(){ closeModal(); resolve(true); });
    });
  }

  /* ============================================================
     State
     ============================================================ */
  var state = {
    currentUser: null,
    employees: [],
    leaveRecords: [],
    users: [],
    currentView: 'dashboard',
    filters: {
      month: new Date().getMonth()+1,
      year: new Date().getFullYear(),
      employeeId: '',
      type: ''
    }
  };

  function employeeById(id){
    for(var i=0;i<state.employees.length;i++){ if(state.employees[i].id===id) return state.employees[i]; }
    return null;
  }

  /* ============================================================
     Auth
     ============================================================ */
  function showAuthCard(id){
    ['authLoading','setupCard','loginCard'].forEach(function(k){
      $('#'+k).hidden = (k !== id);
    });
  }

  function initAuth(){
    showAuthCard('authLoading');
    api('GET', '/api/bootstrap').then(function(data){
      if(data.needsSetup){
        showAuthCard('setupCard');
      } else if(data.user){
        enterApp(data.user);
      } else {
        showAuthCard('loginCard');
      }
    }).catch(function(){
      showAuthCard('loginCard');
    });
  }

  $('#setupCard').addEventListener('submit', function(e){
    e.preventDefault();
    var errEl = $('#setupError');
    errEl.classList.remove('show');
    var username = $('#setupUsername').value.trim();
    var pass = $('#setupPassword').value;
    var pass2 = $('#setupPassword2').value;
    if(!username){ errEl.textContent = 'Informe um usuário.'; errEl.classList.add('show'); return; }
    if(pass.length < 6){ errEl.textContent = 'A senha precisa ter pelo menos 6 caracteres.'; errEl.classList.add('show'); return; }
    if(pass !== pass2){ errEl.textContent = 'As senhas não conferem.'; errEl.classList.add('show'); return; }

    var submitBtn = $('#setupCard button[type="submit"]');
    submitBtn.disabled = true;

    api('POST', '/api/setup', { username: username, password: pass, password2: pass2 }).then(function(data){
      toast('Administrador criado. Bem-vindo(a)!');
      enterApp(data.user);
    }).catch(function(err){
      submitBtn.disabled = false;
      errEl.textContent = err.message || 'Não foi possível criar a conta agora. Tente novamente.';
      errEl.classList.add('show');
    });
  });

  $('#loginCard').addEventListener('submit', function(e){
    e.preventDefault();
    var errEl = $('#loginError');
    errEl.classList.remove('show');
    var username = $('#loginUsername').value.trim();
    var pass = $('#loginPassword').value;
    if(!username || !pass){
      errEl.textContent = 'Informe usuário e senha.'; errEl.classList.add('show'); return;
    }
    var submitBtn = $('#loginCard button[type="submit"]');
    submitBtn.disabled = true;

    api('POST', '/api/login', { username: username, password: pass }).then(function(data){
      enterApp(data.user);
    }).catch(function(err){
      submitBtn.disabled = false;
      errEl.textContent = err.message || 'Usuário ou senha incorretos.';
      errEl.classList.add('show');
    });
  });

  function logout(){
    api('POST', '/api/logout').catch(function(){}).then(function(){
      state.currentUser = null;
      $('#mainShell').hidden = true;
      $('#authScreen').style.display = '';
      $('#loginUsername') && ($('#loginUsername').value = '');
      $('#loginPassword') && ($('#loginPassword').value = '');
      showAuthCard('loginCard');
    });
  }
  $('#logoutBtn').addEventListener('click', logout);

  function enterApp(user){
    state.currentUser = user;
    $('#authScreen').style.display = 'none';
    $('#mainShell').hidden = false;
    $('#sideAvatar').textContent = initials(user.username);
    $('#sideUserName').textContent = user.username;
    $('#sideUserRole').textContent = user.role === 'admin' ? 'Administrador' : 'Usuário';
    $('#navUsers').style.display = user.role === 'admin' ? '' : 'none';
    if(user.role !== 'admin' && state.currentView === 'users'){ state.currentView = 'dashboard'; }
    loadAll().then(function(){
      goTo(location.hash.replace('#','') || 'dashboard');
    });
  }

  /* ============================================================
     Data loading (fetched from the Flask API, reloaded after
     every write since there is no realtime subscription here)
     ============================================================ */
  function loadEmployees(){
    return api('GET', '/api/employees').then(function(data){
      state.employees = data.employees;
      state.employees.sort(function(a,b){ return (a.name||'').localeCompare(b.name||'', 'pt-BR'); });
    });
  }
  function loadLeaves(){
    return api('GET', '/api/leaves').then(function(data){
      state.leaveRecords = data.leaves;
      state.leaveRecords.sort(function(a,b){ return (b.startDate||'').localeCompare(a.startDate||''); });
    });
  }
  function loadUsers(){
    if(!state.currentUser || state.currentUser.role !== 'admin'){ state.users = []; return Promise.resolve(); }
    return api('GET', '/api/users').then(function(data){
      state.users = data.users;
      state.users.sort(function(a,b){ return (a.username||'').localeCompare(b.username||'', 'pt-BR'); });
    });
  }
  function loadAll(){
    return Promise.all([loadEmployees(), loadLeaves(), loadUsers()]).then(function(){
      renderCurrentView();
    }).catch(function(){
      toast('Não foi possível carregar os dados agora.', true);
    });
  }

  /* ============================================================
     Navigation
     ============================================================ */
  function goTo(view){
    var allowed = ['dashboard','employees','leaves','users'];
    if(allowed.indexOf(view) === -1) view = 'dashboard';
    if(view === 'users' && (!state.currentUser || state.currentUser.role !== 'admin')) view = 'dashboard';
    state.currentView = view;
    location.hash = view;
    $all('.nav-item').forEach(function(btn){
      btn.classList.toggle('active', btn.getAttribute('data-view') === view);
    });
    ['dashboard','employees','leaves','users'].forEach(function(v){
      $('#view-'+v).hidden = (v !== view);
    });
    closeSidebarMobile();
    renderCurrentView();
  }
  $('#sideNav').addEventListener('click', function(e){
    var btn = e.target.closest('.nav-item');
    if(btn) goTo(btn.getAttribute('data-view'));
  });
  window.addEventListener('hashchange', function(){
    if(state.currentUser) goTo(location.hash.replace('#',''));
  });

  function openSidebarMobile(){ $('#sidebar').classList.add('open'); $('#backdrop').classList.add('show'); }
  function closeSidebarMobile(){ $('#sidebar').classList.remove('open'); $('#backdrop').classList.remove('show'); }
  $('#menuToggle').addEventListener('click', openSidebarMobile);
  $('#backdrop').addEventListener('click', closeSidebarMobile);

  function renderCurrentView(){
    if(!state.currentUser) return;
    if(state.currentView === 'dashboard') renderDashboard();
    else if(state.currentView === 'employees') renderEmployees();
    else if(state.currentView === 'leaves') renderLeaves();
    else if(state.currentView === 'users') renderUsers();
  }

  /* ============================================================
     Dashboard
     ============================================================ */
  function leaveOverlapsDate(rec, iso){
    return rec.startDate <= iso && rec.endDate >= iso;
  }
  function leaveOverlapsMonth(rec, year, month){
    var monthStart = year+'-'+pad2(month)+'-01';
    var monthEnd = year+'-'+pad2(month)+'-'+pad2(daysInMonth(year,month));
    return rec.startDate <= monthEnd && rec.endDate >= monthStart;
  }

  function renderDashboard(){
    var today = isoToday();
    var now = new Date();
    var dateLine = DOW_FULL(now.getDay()) + ', ' + now.getDate() + ' de ' + MONTHS[now.getMonth()].toLowerCase() + ' de ' + now.getFullYear();
    $('#dashDateLine').textContent = dateLine;

    var activeEmployees = state.employees.filter(function(e){ return e.active !== false; });
    var todaysLeaves = state.leaveRecords.filter(function(r){ return leaveOverlapsDate(r, today); });
    var onVacationToday = todaysLeaves.filter(function(r){ return r.type==='ferias'; }).length;
    var monthRecords = state.leaveRecords.filter(function(r){ return leaveOverlapsMonth(r, now.getFullYear(), now.getMonth()+1); });

    var stats = [
      { label:'Funcionários ativos', value: activeEmployees.length },
      { label:'De férias hoje', value: onVacationToday, accent:true },
      { label:'Ausentes hoje (total)', value: todaysLeaves.length },
      { label:'Registros este mês', value: monthRecords.length }
    ];
    $('#statGrid').innerHTML = stats.map(function(s){
      return '<div class="stat-card"><div class="stat-label">'+escapeHtml(s.label)+'</div><div class="stat-value tabular'+(s.accent?' accent':'')+'">'+s.value+'</div></div>';
    }).join('');

    var todayListEl = $('#todayList');
    if(!todaysLeaves.length){
      todayListEl.innerHTML = '<div class="empty-state" style="padding:18px 4px;">Ninguém ausente hoje.</div>';
    } else {
      todayListEl.innerHTML = todaysLeaves.map(function(r){
        return '<div class="today-row">'
          + '<div class="avatar" style="width:28px;height:28px;font-size:11px;">'+escapeHtml(initials(r.employeeName))+'</div>'
          + '<div class="today-name">'+escapeHtml(r.employeeName)+'</div>'
          + '<span class="pill '+(TYPE_PILL_CLASS[r.type]||'')+'"><span class="pill-dot"></span>'+escapeHtml(TYPE_LABEL[r.type]||r.type)+'</span>'
          + '<div class="today-reason" title="'+escapeHtml(r.reason||'')+'">'+escapeHtml(r.reason||'—')+'</div>'
          + '</div>';
      }).join('');
    }

    var recentListEl = $('#recentList');
    var recent = state.leaveRecords.slice().sort(function(a,b){ return (b.createdAt||'').localeCompare(a.createdAt||''); }).slice(0,6);
    if(!recent.length){
      recentListEl.innerHTML = '<div class="empty-state" style="padding:18px 4px;">Nenhum registro ainda.</div>';
    } else {
      recentListEl.innerHTML = recent.map(function(r){
        var period = r.startDate === r.endDate ? fmtISOToBR(r.startDate) : (fmtISOToBR(r.startDate)+' – '+fmtISOToBR(r.endDate));
        return '<div class="today-row">'
          + '<span class="pill '+(TYPE_PILL_CLASS[r.type]||'')+'"><span class="pill-dot"></span>'+escapeHtml(TYPE_LABEL[r.type]||r.type)+'</span>'
          + '<div class="today-name">'+escapeHtml(r.employeeName)+'</div>'
          + '<div class="today-reason" style="max-width:110px;">'+escapeHtml(period)+'</div>'
          + '</div>';
      }).join('');
    }
  }
  function DOW_FULL(i){
    return ['Domingo','Segunda-feira','Terça-feira','Quarta-feira','Quinta-feira','Sexta-feira','Sábado'][i];
  }

  /* ============================================================
     Employees
     ============================================================ */
  function renderEmployees(){
    var n = state.employees.length;
    $('#empCountLine').textContent = n + (n===1 ? ' funcionário cadastrado' : ' funcionários cadastrados');
    var body = $('#employeesBody');
    $('#employeesEmpty').hidden = n !== 0;
    body.innerHTML = state.employees.map(function(emp){
      return '<tr>'
        + '<td class="cell-name">'+escapeHtml(emp.name)+'</td>'
        + '<td>'+escapeHtml(emp.role||'—')+'</td>'
        + '<td class="cell-muted">'+escapeHtml(emp.department||'—')+'</td>'
        + '<td class="cell-muted tabular">'+ (emp.admissionDate ? fmtISOToBR(emp.admissionDate) : '—') +'</td>'
        + '<td class="tabular">'+(emp.annualDays!=null?emp.annualDays:30)+'</td>'
        + '<td><span class="pill '+(emp.active!==false?'pill-active':'pill-inactive')+'">'+(emp.active!==false?'Ativo':'Inativo')+'</span></td>'
        + '<td><div class="row-actions">'
        + '  <button class="btn btn-icon btn-sm" data-edit-emp="'+emp.id+'" aria-label="Editar" title="Editar">'+iconEdit()+'</button>'
        + '  <button class="btn btn-icon btn-sm" data-del-emp="'+emp.id+'" aria-label="Excluir" title="Excluir">'+iconTrash()+'</button>'
        + '</div></td>'
        + '</tr>';
    }).join('');
  }
  function iconEdit(){ return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"></path><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"></path></svg>'; }
  function iconTrash(){ return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"></path><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"></path></svg>'; }
  function iconPdf(){ return '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8Z"></path><path d="M14 2v6h6"></path><path d="M9 15h1.5a1.5 1.5 0 0 0 0-3H9v5"></path><path d="M13 12v5"></path><path d="M13 14h1.5"></path><path d="M17 12v5"></path><path d="M17 14.2h1.3"></path></svg>'; }

  function employeeFormHtml(emp){
    emp = emp || {};
    return ''
      + '<div class="modal-title">'+(emp.id?'Editar funcionário':'Novo funcionário')+'</div>'
      + '<div id="empFormError" class="form-error"></div>'
      + '<div class="field"><label for="empName">Nome completo</label><input id="empName" type="text" value="'+escapeHtml(emp.name||'')+'" required></div>'
      + '<div class="field-row">'
      + '  <div class="field"><label for="empRole">Cargo</label><input id="empRole" type="text" value="'+escapeHtml(emp.role||'')+'"></div>'
      + '  <div class="field"><label for="empDept">Departamento</label><input id="empDept" type="text" value="'+escapeHtml(emp.department||'')+'"></div>'
      + '</div>'
      + '<div class="field-row">'
      + '  <div class="field"><label for="empAdmission">Admissão</label><input id="empAdmission" type="date" value="'+escapeHtml(emp.admissionDate||'')+'"></div>'
      + '  <div class="field"><label for="empDays">Dias de férias/ano</label><input id="empDays" type="number" min="0" max="60" class="tabular" value="'+(emp.annualDays!=null?emp.annualDays:30)+'"></div>'
      + '</div>'
      + '<div class="field">'
      + '  <label for="empActive">Status</label>'
      + '  <select id="empActive"><option value="1" '+(emp.active!==false?'selected':'')+'>Ativo</option><option value="0" '+(emp.active===false?'selected':'')+'>Inativo</option></select>'
      + '</div>'
      + '<div class="modal-actions">'
      + '  <button type="button" class="btn btn-ghost" id="empCancel">Cancelar</button>'
      + '  <button type="submit" class="btn btn-primary" style="width:auto;">'+(emp.id?'Salvar':'Cadastrar')+'</button>'
      + '</div>';
  }

  function openEmployeeForm(emp){
    var wrap = document.createElement('form');
    wrap.setAttribute('novalidate','');
    wrap.innerHTML = employeeFormHtml(emp);
    $('#modalContent').innerHTML = '';
    $('#modalContent').appendChild(wrap);
    $('#modalBackdrop').hidden = false;
    $('#empCancel').addEventListener('click', closeModal);
    wrap.addEventListener('submit', function(e){
      e.preventDefault();
      var errEl = $('#empFormError');
      errEl.classList.remove('show');
      var name = $('#empName').value.trim();
      if(!name){ errEl.textContent = 'Informe o nome do funcionário.'; errEl.classList.add('show'); return; }
      var data = {
        name: name,
        role: $('#empRole').value.trim(),
        department: $('#empDept').value.trim(),
        admissionDate: $('#empAdmission').value || '',
        annualDays: parseInt($('#empDays').value,10) || 0,
        active: $('#empActive').value === '1'
      };
      var req = emp && emp.id ? api('PUT', '/api/employees/'+emp.id, data) : api('POST', '/api/employees', data);
      req.then(function(){
        closeModal();
        toast(emp && emp.id ? 'Funcionário atualizado.' : 'Funcionário cadastrado.');
        return loadEmployees().then(function(){ loadLeaves(); }).then(renderCurrentView);
      }).catch(function(err){
        errEl.textContent = err.message || 'Não foi possível salvar agora. Tente novamente.';
        errEl.classList.add('show');
      });
    });
  }

  $('#addEmployeeBtn').addEventListener('click', function(){ openEmployeeForm(null); });
  $('#employeesBody').addEventListener('click', function(e){
    var editId = e.target.closest('[data-edit-emp]');
    var delId = e.target.closest('[data-del-emp]');
    if(editId){ openEmployeeForm(employeeById(editId.getAttribute('data-edit-emp'))); }
    if(delId){
      var id = delId.getAttribute('data-del-emp');
      var emp = employeeById(id);
      confirmModal({
        title:'Excluir funcionário',
        message:'Excluir "'+(emp?emp.name:'')+'"? Os registros de ausência já lançados para ele continuam no histórico.',
        confirmLabel:'Excluir', danger:true
      }).then(function(ok){
        if(!ok) return;
        api('DELETE', '/api/employees/'+id).then(function(){
          toast('Funcionário excluído.');
          return loadEmployees().then(function(){ return loadLeaves(); }).then(renderCurrentView);
        }).catch(function(){ toast('Não foi possível excluir agora.', true); });
      });
    }
  });

  /* ============================================================
     Leaves (Ausências)
     ============================================================ */
  function populateFilterSelects(){
    var monthSel = $('#filterMonth');
    if(!monthSel.options.length){
      monthSel.innerHTML = MONTHS.map(function(m,i){ return '<option value="'+(i+1)+'">'+m+'</option>'; }).join('');
    }
    monthSel.value = String(state.filters.month);
    $('#filterYear').value = state.filters.year;

    var empSel = $('#filterEmployee');
    var current = state.filters.employeeId;
    empSel.innerHTML = '<option value="">Todos</option>' + state.employees.map(function(e){
      return '<option value="'+e.id+'">'+escapeHtml(e.name)+'</option>';
    }).join('');
    empSel.value = current;

    $('#filterType').value = state.filters.type;
  }

  ['filterMonth','filterYear','filterEmployee','filterType'].forEach(function(id){
    $('#'+id).addEventListener('change', function(){
      state.filters.month = parseInt($('#filterMonth').value,10);
      state.filters.year = parseInt($('#filterYear').value,10) || new Date().getFullYear();
      state.filters.employeeId = $('#filterEmployee').value;
      state.filters.type = $('#filterType').value;
      renderLeaves();
    });
  });

  function filteredLeaveRecords(){
    return state.leaveRecords.filter(function(r){
      if(state.filters.employeeId && r.employeeId !== state.filters.employeeId) return false;
      if(state.filters.type && r.type !== state.filters.type) return false;
      return leaveOverlapsMonth(r, state.filters.year, state.filters.month);
    });
  }

  function renderLeaves(){
    populateFilterSelects();
    var year = state.filters.year, month = state.filters.month;
    $('#leavesLine').textContent = 'Um ano tem ' + daysInYear(year) + ' dias' + (isLeapYear(year) ? ' (ano bissexto)' : '') + '. Mostrando ' + MONTHS[month-1] + ' de ' + year + '.';

    var records = filteredLeaveRecords();

    // Calendar
    $('#calTitle').textContent = MONTHS[month-1] + ' de ' + year;
    $('#calSub').textContent = records.length + (records.length===1?' registro neste mês':' registros neste mês');
    renderCalendar(year, month, records);

    // Balance
    $('#balanceYear').textContent = year;
    renderBalance(year);

    // Table
    var body = $('#leavesBody');
    $('#leavesEmpty').hidden = records.length !== 0;
    var sorted = records.slice().sort(function(a,b){ return a.startDate.localeCompare(b.startDate); });
    body.innerHTML = sorted.map(function(r){
      var period = r.startDate === r.endDate ? fmtISOToBR(r.startDate) : (fmtISOToBR(r.startDate)+' – '+fmtISOToBR(r.endDate));
      var days = daysBetweenInclusive(r.startDate, r.endDate);
      return '<tr>'
        + '<td class="cell-name">'+escapeHtml(r.employeeName)+'</td>'
        + '<td><span class="pill '+(TYPE_PILL_CLASS[r.type]||'')+'"><span class="pill-dot"></span>'+escapeHtml(TYPE_LABEL[r.type]||r.type)+'</span></td>'
        + '<td class="tabular cell-muted">'+escapeHtml(period)+'</td>'
        + '<td class="tabular">'+days+'</td>'
        + '<td class="cell-muted" style="max-width:220px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="'+escapeHtml(r.reason||'')+'">'+escapeHtml(r.reason||'—')+'</td>'
        + '<td><div class="row-actions">'
        + ((r.type==='folga'||r.type==='ferias') ? '  <button class="btn btn-icon btn-sm" data-pdf-leave="'+r.id+'" aria-label="Gerar PDF de autorização" title="Gerar PDF de autorização">'+iconPdf()+'</button>' : '')
        + '  <button class="btn btn-icon btn-sm" data-edit-leave="'+r.id+'" aria-label="Editar" title="Editar">'+iconEdit()+'</button>'
        + '  <button class="btn btn-icon btn-sm" data-del-leave="'+r.id+'" aria-label="Excluir" title="Excluir">'+iconTrash()+'</button>'
        + '</div></td>'
        + '</tr>';
    }).join('');
  }

  function typeColorVar(type){
    return { ferias:'var(--accent-strong)', folga:'var(--warning)', atestado:'var(--info)', falta:'var(--danger)' }[type] || 'var(--text-muted)';
  }
  function typeSoftVar(type){
    return { ferias:'var(--accent-soft)', folga:'var(--warning-soft)', atestado:'var(--info-soft)', falta:'var(--danger-soft)' }[type] || 'var(--surface-2)';
  }

  function renderCalendar(year, month, records){
    var grid = $('#calGrid');
    var html = DOW.map(function(d){ return '<div class="cal-dow">'+d+'</div>'; }).join('');
    var firstDow = new Date(year, month-1, 1).getDay();
    var totalDays = daysInMonth(year, month);
    var today = isoToday();

    for(var i=0;i<firstDow;i++){ html += '<div class="cal-cell empty"></div>'; }

    for(var day=1; day<=totalDays; day++){
      var iso = year+'-'+pad2(month)+'-'+pad2(day);
      var dayRecords = records.filter(function(r){ return r.startDate <= iso && r.endDate >= iso; });
      var chips = dayRecords.slice(0,3).map(function(r){
        return '<div class="cal-chip" style="background:'+typeSoftVar(r.type)+'; color:'+typeColorVar(r.type)+';">'+escapeHtml((r.employeeName||'').split(' ')[0])+'</div>';
      }).join('');
      var more = dayRecords.length > 3 ? '<div class="cal-more">+'+(dayRecords.length-3)+'</div>' : '';
      html += '<button type="button" class="cal-cell'+(iso===today?' today':'')+'" data-day="'+iso+'">'
        + '<div class="cal-daynum tabular">'+day+'</div>'
        + chips + more
        + '</button>';
    }
    grid.innerHTML = html;
  }

  $('#calGrid').addEventListener('click', function(e){
    var cell = e.target.closest('[data-day]');
    if(!cell) return;
    var iso = cell.getAttribute('data-day');
    var dayRecords = state.leaveRecords.filter(function(r){ return r.startDate <= iso && r.endDate >= iso; });
    openDayModal(iso, dayRecords);
  });

  function openDayModal(iso, records){
    var list = records.length ? records.map(function(r){
      var period = r.startDate === r.endDate ? fmtISOToBR(r.startDate) : (fmtISOToBR(r.startDate)+' – '+fmtISOToBR(r.endDate));
      return '<div class="today-row">'
        + '<span class="pill '+(TYPE_PILL_CLASS[r.type]||'')+'"><span class="pill-dot"></span>'+escapeHtml(TYPE_LABEL[r.type]||r.type)+'</span>'
        + '<div class="today-name">'+escapeHtml(r.employeeName)+'</div>'
        + '<button class="btn btn-icon btn-sm" data-day-edit="'+r.id+'" title="Editar">'+iconEdit()+'</button>'
        + '</div>'
        + '<div class="field-hint" style="margin:-2px 0 8px 0;">'+escapeHtml(period)+(r.reason?(' · '+escapeHtml(r.reason)):'')+'</div>';
    }).join('') : '<div class="empty-state" style="padding:14px 4px;">Ninguém ausente neste dia.</div>';

    openModal(''
      + '<div class="modal-title">'+fmtISOToBR(iso)+'</div>'
      + list
      + '<div class="modal-actions">'
      + '  <button type="button" class="btn btn-ghost" id="dayClose">Fechar</button>'
      + '  <button type="button" class="btn btn-primary" id="dayAdd" style="width:auto;">+ Registrar ausência</button>'
      + '</div>');
    $('#dayClose').addEventListener('click', closeModal);
    $('#dayAdd').addEventListener('click', function(){ openLeaveForm(null, iso); });
    $all('[data-day-edit]').forEach(function(btn){
      btn.addEventListener('click', function(){
        var rec = state.leaveRecords.find(function(r){ return r.id === btn.getAttribute('data-day-edit'); });
        openLeaveForm(rec || null);
      });
    });
  }

  function renderBalance(year){
    var el = $('#balanceList');
    var active = state.employees.filter(function(e){ return e.active !== false; });
    if(!active.length){ el.innerHTML = '<div class="empty-state" style="padding:18px 4px;">Cadastre funcionários para ver o saldo.</div>'; return; }
    el.innerHTML = active.map(function(emp){
      var total = emp.annualDays!=null ? emp.annualDays : 30;
      var used = state.leaveRecords.reduce(function(sum, r){
        if(r.employeeId !== emp.id || r.type !== 'ferias') return sum;
        if(r.startDate.slice(0,4) !== String(year) && r.endDate.slice(0,4) !== String(year)) return sum;
        var clampStart = r.startDate < (year+'-01-01') ? (year+'-01-01') : r.startDate;
        var clampEnd = r.endDate > (year+'-12-31') ? (year+'-12-31') : r.endDate;
        if(clampStart > clampEnd) return sum;
        return sum + daysBetweenInclusive(clampStart, clampEnd);
      }, 0);
      var pct = total > 0 ? Math.min(100, Math.round(used/total*100)) : (used>0?100:0);
      return '<div class="balance-row">'
        + '<div class="balance-name">'+escapeHtml(emp.name)+'</div>'
        + '<div class="balance-track"><div class="balance-fill'+(used>total?' over':'')+'" style="width:'+pct+'%;"></div></div>'
        + '<div class="balance-num tabular">'+used+' / '+total+'</div>'
        + '</div>';
    }).join('');
  }

  function leaveFormHtml(rec, presetDate){
    rec = rec || {};
    var isPeriod = rec.startDate && rec.endDate && rec.startDate !== rec.endDate;
    var start = rec.startDate || presetDate || isoToday();
    var end = rec.endDate || presetDate || isoToday();
    var empOptions = state.employees.map(function(e){
      return '<option value="'+e.id+'" '+(rec.employeeId===e.id?'selected':'')+'>'+escapeHtml(e.name)+'</option>';
    }).join('');
    return ''
      + '<div class="modal-title">'+(rec.id?'Editar registro':'Novo registro')+'</div>'
      + '<div id="leaveFormError" class="form-error"></div>'
      + '<div class="field"><label for="leaveEmp">Funcionário</label><select id="leaveEmp" required><option value="">Selecione…</option>'+empOptions+'</select></div>'
      + '<div class="field"><label for="leaveType">Tipo</label>'
      + '  <select id="leaveType">'
      + '    <option value="ferias" '+(rec.type==='ferias'||!rec.type?'selected':'')+'>Férias</option>'
      + '    <option value="folga" '+(rec.type==='folga'?'selected':'')+'>Folga</option>'
      + '    <option value="atestado" '+(rec.type==='atestado'?'selected':'')+'>Atestado</option>'
      + '    <option value="falta" '+(rec.type==='falta'?'selected':'')+'>Falta</option>'
      + '  </select>'
      + '</div>'
      + '<div class="field"><label>Duração</label>'
      + '  <div class="segmented" id="periodToggle">'
      + '    <button type="button" data-mode="single" class="'+(!isPeriod?'active':'')+'">Dia único</button>'
      + '    <button type="button" data-mode="range" class="'+(isPeriod?'active':'')+'">Período</button>'
      + '  </div>'
      + '</div>'
      + '<div class="field-row">'
      + '  <div class="field"><label for="leaveStart">'+(isPeriod?'Início':'Data')+'</label><input id="leaveStart" type="date" value="'+escapeHtml(start)+'" required></div>'
      + '  <div class="field" id="leaveEndWrap" style="'+(isPeriod?'':'display:none;')+'"><label for="leaveEnd">Fim</label><input id="leaveEnd" type="date" value="'+escapeHtml(end)+'"></div>'
      + '</div>'
      + '<div class="field"><label for="leaveReason">Motivo</label><textarea id="leaveReason" placeholder="Ex: férias programadas, consulta médica...">'+escapeHtml(rec.reason||'')+'</textarea></div>'
      + '<div class="modal-actions">'
      + '  <button type="button" class="btn btn-ghost" id="leaveCancel">Cancelar</button>'
      + '  <button type="submit" class="btn btn-primary" style="width:auto;">'+(rec.id?'Salvar':'Registrar')+'</button>'
      + '</div>';
  }

  function openLeaveForm(rec, presetDate){
    if(!state.employees.length){
      toast('Cadastre pelo menos um funcionário antes de registrar ausências.', true);
      return;
    }
    var wrap = document.createElement('form');
    wrap.setAttribute('novalidate','');
    wrap.innerHTML = leaveFormHtml(rec, presetDate);
    $('#modalContent').innerHTML = '';
    $('#modalContent').appendChild(wrap);
    $('#modalBackdrop').hidden = false;
    $('#leaveCancel').addEventListener('click', closeModal);

    $('#periodToggle').addEventListener('click', function(e){
      var btn = e.target.closest('button[data-mode]');
      if(!btn) return;
      $all('#periodToggle button').forEach(function(b){ b.classList.remove('active'); });
      btn.classList.add('active');
      var isRange = btn.getAttribute('data-mode') === 'range';
      $('#leaveEndWrap').style.display = isRange ? '' : 'none';
      $('label[for="leaveStart"]').textContent = isRange ? 'Início' : 'Data';
      if(!isRange){ $('#leaveEnd').value = $('#leaveStart').value; }
    });

    wrap.addEventListener('submit', function(e){
      e.preventDefault();
      var errEl = $('#leaveFormError');
      errEl.classList.remove('show');
      var empId = $('#leaveEmp').value;
      if(!empId){ errEl.textContent = 'Selecione o funcionário.'; errEl.classList.add('show'); return; }
      var isRange = $('#leaveEndWrap').style.display !== 'none';
      var start = $('#leaveStart').value;
      var end = isRange ? ($('#leaveEnd').value || start) : start;
      if(!start){ errEl.textContent = 'Informe a data.'; errEl.classList.add('show'); return; }
      if(end < start){ errEl.textContent = 'A data final não pode ser antes da inicial.'; errEl.classList.add('show'); return; }
      var data = {
        employeeId: empId,
        type: $('#leaveType').value,
        startDate: start,
        endDate: end,
        reason: $('#leaveReason').value.trim()
      };
      var req = rec && rec.id ? api('PUT', '/api/leaves/'+rec.id, data) : api('POST', '/api/leaves', data);
      req.then(function(){
        closeModal();
        toast(rec && rec.id ? 'Registro atualizado.' : 'Ausência registrada.');
        return loadLeaves().then(renderCurrentView);
      }).catch(function(err){
        errEl.textContent = err.message || 'Não foi possível salvar agora. Tente novamente.';
        errEl.classList.add('show');
      });
    });
  }

  $('#addLeaveBtn').addEventListener('click', function(){ openLeaveForm(null); });
  $('#leavesBody').addEventListener('click', function(e){
    var editId = e.target.closest('[data-edit-leave]');
    var delId = e.target.closest('[data-del-leave]');
    var pdfId = e.target.closest('[data-pdf-leave]');
    if(pdfId){
      window.open('/leaves/'+pdfId.getAttribute('data-pdf-leave')+'/autorizacao', '_blank');
      return;
    }
    if(editId){
      var rec = state.leaveRecords.find(function(r){ return r.id === editId.getAttribute('data-edit-leave'); });
      openLeaveForm(rec || null);
    }
    if(delId){
      var id = delId.getAttribute('data-del-leave');
      confirmModal({ title:'Excluir registro', message:'Excluir este registro de ausência? Essa ação não pode ser desfeita.', confirmLabel:'Excluir', danger:true })
        .then(function(ok){
          if(!ok) return;
          api('DELETE', '/api/leaves/'+id).then(function(){
            toast('Registro excluído.');
            return loadLeaves().then(renderCurrentView);
          }).catch(function(){ toast('Não foi possível excluir agora.', true); });
        });
    }
  });

  $('#exportCsvBtn').addEventListener('click', function(){
    var records = filteredLeaveRecords();
    if(!records.length){ toast('Não há registros para exportar com esse filtro.', true); return; }
    var params = new URLSearchParams({
      month: String(state.filters.month),
      year: String(state.filters.year),
      employeeId: state.filters.employeeId || '',
      type: state.filters.type || ''
    });
    window.location = '/api/leaves/export?' + params.toString();
    toast('CSV exportado.');
  });

  /* ============================================================
     Users
     ============================================================ */
  function renderUsers(){
    if(!state.currentUser || state.currentUser.role !== 'admin') return;
    var body = $('#usersBody');
    body.innerHTML = state.users.map(function(u){
      var isSelf = state.currentUser && state.currentUser.id === u.id;
      var createdAt = u.createdAt ? fmtISOToBR(u.createdAt.slice(0,10)) : '—';
      return '<tr>'
        + '<td class="cell-name">'+escapeHtml(u.username)+(isSelf?' <span class="cell-muted">(você)</span>':'')+'</td>'
        + '<td><span class="pill '+(u.role==='admin'?'pill-admin':'pill-user')+'">'+(u.role==='admin'?'Administrador':'Usuário')+'</span></td>'
        + '<td class="cell-muted tabular">'+createdAt+'</td>'
        + '<td><div class="row-actions">'
        + (isSelf ? '' : '<button class="btn btn-icon btn-sm" data-del-user="'+u.id+'" aria-label="Excluir" title="Excluir">'+iconTrash()+'</button>')
        + '</div></td>'
        + '</tr>';
    }).join('');
  }

  function userFormHtml(){
    return ''
      + '<div class="modal-title">Novo usuário</div>'
      + '<div id="userFormError" class="form-error"></div>'
      + '<div class="field"><label for="newUsername">Usuário</label><input id="newUsername" type="text" autocomplete="off" required></div>'
      + '<div class="field"><label for="newUserPass">Senha</label><input id="newUserPass" type="password" autocomplete="new-password" minlength="6" required></div>'
      + '<div class="field"><label for="newUserRole">Perfil</label><select id="newUserRole"><option value="user">Usuário</option><option value="admin">Administrador</option></select></div>'
      + '<div class="field-hint">Administradores podem gerenciar funcionários, ausências e outros usuários.</div>'
      + '<div class="modal-actions">'
      + '  <button type="button" class="btn btn-ghost" id="userCancel">Cancelar</button>'
      + '  <button type="submit" class="btn btn-primary" style="width:auto;">Criar usuário</button>'
      + '</div>';
  }

  $('#addUserBtn').addEventListener('click', function(){
    var wrap = document.createElement('form');
    wrap.setAttribute('novalidate','');
    wrap.innerHTML = userFormHtml();
    $('#modalContent').innerHTML = '';
    $('#modalContent').appendChild(wrap);
    $('#modalBackdrop').hidden = false;
    $('#userCancel').addEventListener('click', closeModal);
    wrap.addEventListener('submit', function(e){
      e.preventDefault();
      var errEl = $('#userFormError');
      errEl.classList.remove('show');
      var username = $('#newUsername').value.trim();
      var pass = $('#newUserPass').value;
      var role = $('#newUserRole').value;
      if(!username){ errEl.textContent = 'Informe um usuário.'; errEl.classList.add('show'); return; }
      if(pass.length < 6){ errEl.textContent = 'A senha precisa ter pelo menos 6 caracteres.'; errEl.classList.add('show'); return; }
      api('POST', '/api/users', { username: username, password: pass, role: role }).then(function(){
        closeModal();
        toast('Usuário criado.');
        return loadUsers().then(renderCurrentView);
      }).catch(function(err){
        errEl.textContent = err.message || 'Não foi possível criar agora. Tente novamente.';
        errEl.classList.add('show');
      });
    });
  });

  $('#usersBody').addEventListener('click', function(e){
    var delBtn = e.target.closest('[data-del-user]');
    if(!delBtn) return;
    var id = delBtn.getAttribute('data-del-user');
    var target = state.users.find(function(u){ return u.id === id; });
    if(!target) return;
    if(target.role === 'admin' && state.users.filter(function(u){ return u.role==='admin'; }).length <= 1){
      toast('Não é possível excluir o único administrador.', true);
      return;
    }
    confirmModal({ title:'Excluir usuário', message:'Excluir o acesso de "'+target.username+'"?', confirmLabel:'Excluir', danger:true })
      .then(function(ok){
        if(!ok) return;
        api('DELETE', '/api/users/'+id).then(function(){
          toast('Usuário excluído.');
          return loadUsers().then(renderCurrentView);
        }).catch(function(err){ toast(err.message || 'Não foi possível excluir agora.', true); });
      });
  });

  /* ============================================================
     Init
     ============================================================ */
  initAuth();

})();
