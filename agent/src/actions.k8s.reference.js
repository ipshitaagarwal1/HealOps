// REFERENCE ONLY, NOT WIRED IN. Not imported anywhere and @kubernetes/client-node is not
// a dependency. Shows what act.js would call against a real Kubernetes cluster instead of
// the demo services' /admin endpoints. Written for @kubernetes/client-node 1.x/2.x, where
// API methods take one object of named parameters.
//
// In a cluster, the agent would run with a ServiceAccount whose Role allows only:
//   pods: delete; deployments: get, patch; replicasets: list (and nothing cluster-wide).

import * as k8s from '@kubernetes/client-node';

const kc = new k8s.KubeConfig();
kc.loadFromDefault(); // in-cluster: uses the pod's ServiceAccount token
const core = kc.makeApiClient(k8s.CoreV1Api);
const apps = kc.makeApiClient(k8s.AppsV1Api);

// restart_pod: delete one pod; the Deployment's ReplicaSet creates a replacement.
// (For "restart all pods" use a rollout restart: patch the template annotation
//  kubectl.kubernetes.io/restartedAt, as `kubectl rollout restart` does.)
export async function restartPod(namespace, service) {
  const pods = await core.listNamespacedPod({ namespace, labelSelector: `app=${service}` });
  const pod = pods.items.find((p) => p.status?.phase === 'Running') ?? pods.items[0];
  if (!pod) throw new Error(`no pods for app=${service}`);
  await core.deleteNamespacedPod({ name: pod.metadata.name, namespace });
  return { deleted: pod.metadata.name };
}

// scale_up: add one replica with a merge patch on the Deployment.
export async function scaleUp(namespace, service, maxReplicas = 10) {
  const dep = await apps.readNamespacedDeployment({ name: service, namespace });
  const replicas = Math.min(maxReplicas, (dep.spec?.replicas ?? 1) + 1);
  await apps.patchNamespacedDeployment(
    { name: service, namespace, body: { spec: { replicas } } },
    k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.MergePatch),
  );
  return { replicas };
}

// rollback_deploy: there is no rollout-undo API; `kubectl rollout undo` copies the
// previous ReplicaSet's pod template back onto the Deployment. Same here.
export async function rollbackDeploy(namespace, service) {
  const dep = await apps.readNamespacedDeployment({ name: service, namespace });
  const selector = Object.entries(dep.spec.selector.matchLabels).map(([k, v]) => `${k}=${v}`).join(',');
  const sets = await apps.listNamespacedReplicaSet({ namespace, labelSelector: selector });
  const revision = (rs) => Number(rs.metadata.annotations?.['deployment.kubernetes.io/revision'] ?? 0);
  const [, previous] = sets.items.sort((a, b) => revision(b) - revision(a));
  if (!previous) throw new Error(`no previous revision for ${service}`);
  const template = structuredClone(previous.spec.template);
  delete template.metadata.labels['pod-template-hash'];
  await apps.patchNamespacedDeployment(
    { name: service, namespace, body: { spec: { template } } },
    k8s.setHeaderOptions('Content-Type', k8s.PatchStrategy.StrategicMergePatch),
  );
  return { rolled_back_to_revision: revision(previous) };
}
