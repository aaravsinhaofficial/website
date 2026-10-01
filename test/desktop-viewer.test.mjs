import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
const source = (await readFile(new URL('../desktop/src/viewer.js', import.meta.url), 'utf8')).replace(/^import RFB[^\n]+\n/, '');
const settle = () => new Promise(resolve => setImmediate(resolve));
async function viewer(initial = {authenticated:true, desktopAvailable:true}) {
  const elements = new Map(), clients = [], requests = [], timers = new Map();
  let authState = initial, nextTimer = 0, logoutOk = true;
  function target() { return {events:new Map(), addEventListener(name, fn){this.events.set(name, fn);}, async dispatch(name, detail){await this.events.get(name)?.({detail, preventDefault(){}, currentTarget:this});await settle();}}; }
  function el(id) {
    if (!elements.has(id)) elements.set(id, {...target(),hidden:false,disabled:false,value:'',attrs:{},setAttribute(k,v){this.attrs[k]=v;},getAttribute(k){return this.attrs[k];},focus(){},querySelector(){return el(`${id}-button`);}});
    return elements.get(id);
  }
  class RFB {
    constructor(target, url, options) { Object.assign(this, {target,url,options,...targetMock()}); clients.push(this); }
    disconnect(){this.disconnected=true;this.events.get('disconnect')?.({detail:{clean:true}});}
    sendCredentials(value){this.sentCredentials=value;}
    sendKey(){}
    focus(){}
  }
  function targetMock(){return target();}
  const window = target();
  vm.runInNewContext(source,{RFB,document:{getElementById:el},window,URL,AbortSignal,location:{origin:'https://aaravsinha.dev',protocol:'https:'},setTimeout(fn){timers.set(++nextTimer,fn);return nextTimer;},clearTimeout(id){timers.delete(id);},async fetch(url,options){requests.push({url,options});assert.ok(url.startsWith('/desktop/session/'));if(url.endsWith('/auth/logout')){if(logoutOk)authState={...authState,authenticated:false};return {ok:logoutOk,json:async()=>({})};}return {ok:true,json:async()=>authState};}});
  await settle();
  return {el,clients,requests,window,timers,setState(value){authState=value;},failLogout(){logoutOk=false;},async retry(){const [id,fn]=timers.entries().next().value;timers.delete(id);await fn();await settle();}};
}
test('desktop asks for the website password and does not connect before login',async()=>{
  const page=await viewer({authenticated:false,desktopAvailable:true});
  assert.equal(page.clients.length,0);assert.equal(page.el('login').hidden,false);
  page.el('password').value='test-only-website-password';
  page.setState({authenticated:true,desktopAvailable:true});
  await page.el('login').dispatch('submit');
  const login=page.requests.find(request=>request.url.endsWith('/auth/login'));
  assert.deepEqual(JSON.parse(login.options.body),{password:'test-only-website-password'});
  assert.equal(page.el('password').value,'');assert.equal(page.clients.length,1);
});
test('relay reconnect keeps Mac credentials only in the current page and uses same-origin WSS',async()=>{
  const page=await viewer();const first=page.clients[0];assert.equal(first.url,'wss://aaravsinha.dev/desktop/session/websockify');
  await first.dispatch('credentialsrequired',{types:['username','password']});page.el('username').value='example';page.el('mac-password').value='test-only-Mac-password';
  await page.el('mac-login').dispatch('submit');assert.equal(page.el('mac-password').value,'');await first.dispatch('connect');
  await first.dispatch('disconnect',{clean:false});await page.retry();const second=page.clients[1];assert.equal(second.options.credentials.password,'test-only-Mac-password');
  assert.equal(page.requests.some(request=>request.options.body?.includes('test-only-Mac-password')),false);
  await page.el('lock').dispatch('click');assert.equal(second.disconnected,true);assert.equal(page.el('login').hidden,false);
  page.setState({authenticated:true,desktopAvailable:true});await page.el('reconnect').dispatch('click');assert.equal(page.clients[2].options.credentials,undefined);
});
test('invalid Mac credentials stop retries until an explicit reconnect',async()=>{
  const page=await viewer();await page.clients[0].dispatch('securityfailure');await page.clients[0].dispatch('disconnect',{clean:false});assert.equal(page.timers.size,0);assert.match(page.el('status').textContent,/failed/);
  await page.el('reconnect').dispatch('click');assert.equal(page.clients.length,2);assert.equal(page.clients[1].options.credentials,undefined);
});
test('failed logout disconnects control and reports that server logout was not confirmed',async()=>{
  const page=await viewer();page.failLogout();await page.el('lock').dispatch('click');assert.equal(page.clients[0].disconnected,true);assert.match(page.el('message').textContent,/Could not confirm logout/);assert.equal(page.el('lock').disabled,false);assert.equal(page.timers.size,0);
});
