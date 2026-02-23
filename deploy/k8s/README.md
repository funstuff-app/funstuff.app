# DustyTrails Kubernetes Deployment

Deploy the DustyTrails dashboard to Kubernetes (DigitalOcean DOKS or any K8s cluster).

## Prerequisites

- Kubernetes cluster (DOKS, EKS, GKE, etc.)
- `kubectl` configured to access your cluster
- Container registry with the `dustytrails` image pushed
- NGINX Ingress Controller installed (optional, for ingress)

## Quick Deploy

```bash
# Build and push the container image
docker build -t your-registry/dustytrails:latest .
docker push your-registry/dustytrails:latest

# Update deployment.yaml with your image registry
# Then apply all manifests:
kubectl apply -k deploy/k8s/

# Or apply individually:
kubectl apply -f deploy/k8s/namespace.yaml
kubectl apply -f deploy/k8s/configmap.yaml
kubectl apply -f deploy/k8s/pvc.yaml
kubectl apply -f deploy/k8s/deployment.yaml
kubectl apply -f deploy/k8s/service.yaml
kubectl apply -f deploy/k8s/ingress.yaml
kubectl apply -f deploy/k8s/hpa.yaml
```

## Configuration

### Update Image Registry

Edit `deployment.yaml` and replace `dustytrails:latest` with your registry:

```yaml
image: your-registry.com/dustytrails:latest
```

### Update Domain

Edit `ingress.yaml` and replace `dustytrails.example.com` with your domain:

```yaml
- host: your-domain.com
```

### Environment Variables

Edit `configmap.yaml` to adjust server settings:

```yaml
data:
  SERVER_PORT: "8766"
  DATA_MODE: "proxy"
  FETCH_INTERVAL: "60"
```

## Scaling

The HPA (Horizontal Pod Autoscaler) automatically scales pods based on CPU/memory:

- **Min replicas:** 2 (for high availability)
- **Max replicas:** 10 (adjust based on expected load)
- **Scale up:** When CPU > 70% or memory > 80%
- **Scale down:** Gradual, to avoid flapping

Manual scaling:

```bash
kubectl scale deployment dustytrails -n dustytrails --replicas=5
```

## Cloudflare Integration

For optimal performance with Cloudflare:

1. Point your domain DNS to the DigitalOcean Load Balancer IP
2. Enable Cloudflare proxy (orange cloud)
3. Set Cloudflare caching rules:
   - `/api/state` - Edge TTL: 30 seconds
   - `/api/config` - Edge TTL: 5 minutes
   - Static assets - Edge TTL: 1 day

The server already sends appropriate `Cache-Control` headers.

## Monitoring

```bash
# Check deployment status
kubectl get pods -n dustytrails

# View logs
kubectl logs -f deployment/dustytrails -n dustytrails

# Check HPA status
kubectl get hpa -n dustytrails

# Describe ingress
kubectl describe ingress dustytrails -n dustytrails
```

## Cleanup

```bash
kubectl delete -k deploy/k8s/
```

## Files

| File | Description |
|------|-------------|
| `namespace.yaml` | Dedicated namespace for isolation |
| `configmap.yaml` | Environment configuration |
| `pvc.yaml` | Persistent storage for cache/snapshots |
| `deployment.yaml` | Pod deployment with replicas |
| `service.yaml` | Internal ClusterIP service |
| `ingress.yaml` | External access via load balancer |
| `hpa.yaml` | Auto-scaling configuration |
| `kustomization.yaml` | Kustomize for easy deployment |
