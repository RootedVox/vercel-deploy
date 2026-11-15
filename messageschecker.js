  (async()=>{
    const session=await RootedVoxAuth.getSession().catch(()=>null);
    if(session?.authenticated){
      location.replace(session.user?.checker?'/checker-pending.html':'/login-messageschecker.html?error=forbidden');
      return;
    }
    location.replace('/auth/login?return_to=%2Fchecker-pending.html');
  })();
