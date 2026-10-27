import { afterEach,expect,it,vi } from 'vitest';
const rpc=vi.hoisted(()=>({call:vi.fn(),metadata:vi.fn(),close:vi.fn(async()=>{})}));
vi.mock('../src/harness/rpc',()=>({createHarnessRpc:()=>rpc}));
import { createNestOSNodeDriver } from '../src/provider';
const descriptor={version:1,fileProtocol:'fs-agent-http-v1',serverId:'personal',httpEndpoint:'./',harness:false,projects:true,projectProtocol:'fs-agent-project-v1'};
afterEach(()=>vi.resetAllMocks());
it.each(['itookit/nestos-node','itookit/pi-agent','itookit/fs-agent'])('reuses %s discovery metadata without invoking a capability tool',async key=>{
    rpc.metadata.mockResolvedValue({[key]:descriptor});const driver=createNestOSNodeDriver();
    expect(await driver.discover({endpoint:'https://pi.test/mcp',credentialRef:'ref'})).toMatchObject({serverId:'personal'});
    expect(rpc.call).not.toHaveBeenCalled();await driver.dispose();
});
it('rejects an invalid advertised descriptor without probing a fallback tool',async()=>{
    rpc.metadata.mockResolvedValue({'itookit/pi-agent':{...descriptor,httpEndpoint:'https://other.test'}});const driver=createNestOSNodeDriver();
    await expect(driver.discover({endpoint:'https://pi.test/mcp',credentialRef:'ref'})).rejects.toThrow('Invalid nestos-node HTTP endpoint');
    expect(rpc.call).not.toHaveBeenCalled();await driver.dispose();
});
it('prefers the nestos-node discovery tool and preserves the shared file protocol',async()=>{
    rpc.call.mockResolvedValue(descriptor);const driver=createNestOSNodeDriver();
    expect(await driver.discover({endpoint:'https://pi.test/mcp',credentialRef:'ref'})).toMatchObject({httpEndpoint:'https://pi.test',serverId:'personal'});
    expect(rpc.call).toHaveBeenCalledWith('nestos_node_capabilities',{},undefined);expect(rpc.call).toHaveBeenCalledTimes(1);await driver.dispose();
});
it('falls back only when an older server lacks the renamed capability tool',async()=>{
    rpc.call.mockRejectedValueOnce({remoteCode:'ECAPABILITY'}).mockResolvedValueOnce(descriptor);const driver=createNestOSNodeDriver();
    await driver.discover({endpoint:'https://pi.test/mcp',credentialRef:'ref'});
    expect(rpc.call.mock.calls.map(c=>c[0])).toEqual(['nestos_node_capabilities','piagent_capabilities']);await driver.dispose();
});
it('falls back to the original fs-agent only after both newer tools are unavailable',async()=>{
    rpc.call.mockRejectedValueOnce({code:-32601}).mockRejectedValueOnce({remoteCode:'ECAPABILITY'}).mockResolvedValueOnce(descriptor);
    const driver=createNestOSNodeDriver();await driver.discover({endpoint:'https://pi.test/mcp',credentialRef:'ref'});
    expect(rpc.call.mock.calls.map(c=>c[0])).toEqual(['nestos_node_capabilities','piagent_capabilities','fsagent_capabilities']);await driver.dispose();
});
it('keeps authentication and network errors visible without trying another name',async()=>{
    rpc.call.mockRejectedValueOnce(new Error('authentication failed'));const driver=createNestOSNodeDriver();
    await expect(driver.discover({endpoint:'https://pi.test/mcp',credentialRef:'ref'})).rejects.toThrow('authentication failed');expect(rpc.call).toHaveBeenCalledTimes(1);await driver.dispose();
});
