import os
import tempfile
import unittest

from mobileair.roads import RoadGraph, RoadGraphConfig, match_trail_segment_offline, trace_road_between_gps_points


class TestRoads(unittest.TestCase):
    def test_match_trail_segment_offline_preserves_endpoint_fields_and_caps(self):
        # Build a tiny graph: a right-angle road (0,0)->(0,0.001)->(0.001,0.001)
        nodes = [(0.0, 0.0), (0.0, 0.001), (0.001, 0.001)]
        adj = [
            [(1, 111.0)],
            [(0, 111.0), (2, 111.0)],
            [(1, 111.0)],
        ]
        g = RoadGraph(nodes, adj, cfg=RoadGraphConfig(grid_deg=1.0, grid_radius=0, max_expansions=1000))

        prev = {"lat": 0.0, "lon": 0.0, "t": "2026-01-09T00:00:00.000Z", "m": 1, "readings": {"k": "pm25"}, "color": "#ff0000"}
        nxt = {"lat": 0.001, "lon": 0.001, "t": "2026-01-09T00:10:00.000Z", "m": 1, "readings": {"k": "pm25"}, "color": "#00ff00"}

        out = match_trail_segment_offline(g, prev, nxt, max_output_points=10, spacing_m=25.0)
        self.assertIsNotNone(out)
        assert out is not None

        # Output excludes prev and includes next.
        self.assertGreaterEqual(len(out), 1)
        self.assertEqual(out[-1]["lat"], nxt["lat"])
        self.assertEqual(out[-1]["lon"], nxt["lon"])

        # Inherits fields from destination point (color/readings).
        for p in out:
            self.assertEqual(p.get("color"), nxt["color"])
            self.assertEqual(p.get("readings"), nxt["readings"])
            self.assertEqual(p.get("m"), 1)

        # Time must be monotonic and within [prev, nxt].
        times = [p["t"] for p in out]
        self.assertTrue(all(isinstance(t, str) for t in times))
        self.assertGreaterEqual(times[0], prev["t"])
        self.assertLessEqual(times[-1], nxt["t"])

        # Cap respected.
        self.assertLessEqual(len(out), 10)

    def test_graph_load_roundtrip(self):
        nodes = [(1.0, 2.0), (3.0, 4.0)]
        adj = [[(1, 5.0)], [(0, 5.0)]]
        with tempfile.TemporaryDirectory() as td:
            p = os.path.join(td, "g.json")
            with open(p, "w", encoding="utf-8") as f:
                import json

                json.dump({"version": 1, "nodes": [[1.0, 2.0], [3.0, 4.0]], "adj": [[[1, 5.0]], [[0, 5.0]]]}, f)
            g = RoadGraph.load(p)
            self.assertEqual(g.nodes, nodes)
            self.assertEqual(g.adj[0][0][0], 1)

    def test_snap_to_edge_returns_edge_info(self):
        """Test that snap_to_edge returns the correct edge endpoints."""
        # Road at lat=40.0, from lon=-111.0 to lon=-110.99
        nodes = [(40.0, -111.0), (40.0, -110.99)]
        adj = [[(1, 900.0)], [(0, 900.0)]]
        g = RoadGraph(nodes, adj, cfg=RoadGraphConfig(grid_deg=0.1, grid_radius=2))

        # Point on the edge
        result = g.snap_to_edge(40.0, -110.995, max_snap_distance_m=50.0)
        self.assertIsNotNone(result)
        lat, lon, node_a, node_b = result
        self.assertAlmostEqual(lat, 40.0, places=5)
        self.assertAlmostEqual(lon, -110.995, places=5)
        self.assertIn(node_a, [0, 1])
        self.assertIn(node_b, [0, 1])
        self.assertNotEqual(node_a, node_b)

    def test_snap_to_edge_returns_none_if_too_far(self):
        """Test that snap_to_edge returns None if point is too far from roads."""
        nodes = [(40.0, -111.0), (40.0, -110.99)]
        adj = [[(1, 900.0)], [(0, 900.0)]]
        g = RoadGraph(nodes, adj, cfg=RoadGraphConfig(grid_deg=0.1, grid_radius=2))

        # Point 1km away - should not snap with 50m threshold
        result = g.snap_to_edge(40.01, -110.995, max_snap_distance_m=50.0)
        self.assertIsNone(result)

    def test_trace_road_corner(self):
        """Test that trace_road_between_gps_points follows a corner."""
        # L-shaped road: (40.0, -111.0) -> (40.0, -110.995) -> (40.005, -110.995)
        nodes = [
            (40.0, -111.0),      # 0: start
            (40.0, -110.995),    # 1: corner
            (40.005, -110.995),  # 2: end
        ]
        adj = [
            [(1, 400.0)],
            [(0, 400.0), (2, 550.0)],
            [(1, 550.0)],
        ]
        g = RoadGraph(nodes, adj, cfg=RoadGraphConfig(grid_deg=0.1, grid_radius=2))

        # GPS points that cut across the corner
        prev = {'lat': 40.0, 'lon': -111.0, 't': '2026-01-10T12:00:00.000Z', 'm': 1}
        next_pt = {'lat': 40.005, 'lon': -110.995, 't': '2026-01-10T12:05:00.000Z', 'm': 1}

        result = trace_road_between_gps_points(g, prev, next_pt, max_waypoints=30)
        self.assertIsNotNone(result)
        self.assertGreater(len(result), 1)

        # Check all waypoints are marked
        for wp in result:
            self.assertEqual(wp.get('wp'), 1)

        # Check that a corner waypoint exists near (40.0, -110.995)
        has_corner = any(
            abs(wp['lat'] - 40.0) < 0.001 and abs(wp['lon'] - (-110.995)) < 0.001
            for wp in result
        )
        self.assertTrue(has_corner, "Expected a waypoint near the corner")

    def test_trace_road_curved_path(self):
        """Test that trace_road_between_gps_points follows a curved road."""
        # Curved road with 5 nodes
        nodes = [
            (40.000, -111.000),
            (40.002, -110.998),
            (40.005, -110.996),  # apex
            (40.008, -110.994),
            (40.010, -110.990),
        ]
        adj = [
            [(1, 300.0)],
            [(0, 300.0), (2, 400.0)],
            [(1, 400.0), (3, 400.0)],
            [(2, 400.0), (4, 300.0)],
            [(3, 300.0)],
        ]
        g = RoadGraph(nodes, adj, cfg=RoadGraphConfig(grid_deg=0.1, grid_radius=2))

        # GPS from start to end
        prev = {'lat': 40.000, 'lon': -111.000, 't': '2026-01-10T12:00:00.000Z', 'm': 1}
        next_pt = {'lat': 40.010, 'lon': -110.990, 't': '2026-01-10T12:10:00.000Z', 'm': 1}

        result = trace_road_between_gps_points(g, prev, next_pt, max_waypoints=50)
        self.assertIsNotNone(result)
        self.assertGreater(len(result), 3)

        # Check path deviates from straight line (follows curve)
        straight_slope = (40.010 - 40.000) / (-110.990 - (-111.000))
        max_deviation = 0.0
        for wp in result:
            expected_lat = 40.000 + straight_slope * (wp['lon'] - (-111.000))
            deviation = abs(wp['lat'] - expected_lat)
            max_deviation = max(max_deviation, deviation)

        # Should deviate by at least ~100m (~0.001 degrees)
        self.assertGreater(max_deviation, 0.001, "Path should follow curve, not straight line")

    def test_trace_road_returns_none_for_short_segment(self):
        """Test that trace_road_between_gps_points returns None for short segments."""
        nodes = [(40.0, -111.0), (40.0, -110.99)]
        adj = [[(1, 900.0)], [(0, 900.0)]]
        g = RoadGraph(nodes, adj, cfg=RoadGraphConfig(grid_deg=0.1, grid_radius=2))

        # Points very close together (< 30m)
        prev = {'lat': 40.0, 'lon': -111.0, 't': '2026-01-10T12:00:00.000Z', 'm': 1}
        next_pt = {'lat': 40.0001, 'lon': -111.0001, 't': '2026-01-10T12:01:00.000Z', 'm': 1}

        result = trace_road_between_gps_points(g, prev, next_pt)
        self.assertIsNone(result)  # Too short to be worth tracing


if __name__ == "__main__":
    unittest.main()
