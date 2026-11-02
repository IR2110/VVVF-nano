import {ConsistEngine} from "./consist-engine.js?v=20261102-immediate";

// A DedicatedWorker + BroadcastChannel works on Android as well as desktop;
// it does not require SharedWorker support or an installed helper process.
let session, members, channel, engine;
const now = () => performance.timeOrigin + performance.now();
onmessage = ({data}) => {
	if (data.type === "init") {
		({session, members} = data);
		members = [...members].sort();
		channel = new BroadcastChannel(`vvvf-motion-v2:${data.scope}:${data.token}`);
		if (session === members[0]) engine = new ConsistEngine({members, token: data.token, now,
			emit: (to, body) => to === session ? postMessage(body) : channel.postMessage({to, from: session, body})});
		channel.onmessage = ({data: message}) => {
			if (!members.includes(message.from) || message.to !== session) return;
			if (engine) engine.receive(message.from, message.body);
			else if (message.from === members[0]) postMessage(message.body);
		};
		return;
	}
	if (!channel) return;
	if (engine) engine.receive(session, data);
	else channel.postMessage({from: session, to: members[0], body: data});
};
setInterval(() => engine?.tick(), 50);
