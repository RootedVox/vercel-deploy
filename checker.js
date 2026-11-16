// Copyright (c) 2026 RootedVox
// Copyright (c) 2026 沧海四象
// Licensed under the MIT License.
// 加载审核导航 + 自动高亮当前页面菜单
// scripts/sync-layout.mjs writes the navigation into each page; a page that was not
// synced still gets it by request.
const checkHeader = document.querySelector("#checkHeader");
(checkHeader.childElementCount
    ? Promise.resolve()
    : fetch("header-checker.html?v=4.3.3").then(res=>res.text()).then(html=>{ checkHeader.innerHTML = html; }))
.then(()=>{
    // 汉堡菜单
    const menuBtn = document.getElementById("menuBtn");
    const navList = document.getElementById("navList");
    if(menuBtn&&navList){
        menuBtn.onclick = () => {
            const open = navList.classList.toggle("show");
            menuBtn.setAttribute("aria-expanded", String(open));
        };
    }
// 自动匹配页面，兼容线上无.html / 本地带.html
let pageRaw = location.pathname.split('/').pop();
let currPage = pageRaw.replace(/\.html$/,'');
if(currPage === '') currPage = 'checker-pending';

const featuredQueue = currPage === 'checker-pending' && new URLSearchParams(location.search).get('queue') === 'featured';
if (featuredQueue) currPage += '?queue=featured';

const links = document.querySelectorAll("#navList a");
links.forEach(link=>{
    link.classList.remove("active");
    link.removeAttribute("aria-current");
    let hrefRaw = link.getAttribute("href");
    let hrefName = hrefRaw.split('/').pop().replace(/\.html$/,'');
    if(hrefName === currPage){
        link.classList.add("active");
        link.setAttribute("aria-current", "page");
    }
})
})