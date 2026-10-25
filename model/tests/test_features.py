import numpy as np

from kutle_health.features import CellRecord, cell_features, cycles_to_threshold


def make_cell(n=200, fade=0.0015, r0=0.05):
    cyc = np.arange(1, n + 1, dtype=float)
    cap = 1.0 * (1.0 - fade * cyc)
    res = np.full(n, np.nan)
    res[::10] = r0 * (1 + 0.002 * cyc[::10])
    return CellRecord(
        dataset="synthetic",
        cell_id="c1",
        rated_ah=1.0,
        chemistry="test",
        capacity_ah=cap,
        resistance_ohm=res,
        t_mean_cycle=25 + 0.01 * cyc,
        t_max_cycle=30 + 0.01 * cyc,
        v_mean_dis=3.7 - 0.0005 * cyc,
        chg_c=np.full(n, 0.5),
        dis_c=np.r_[np.full(n // 2, 1.0), np.full(n - n // 2, 2.0)],
    )


def test_basic_shapes_and_values():
    f = cell_features(make_cell())
    assert len(f["cycle"]) == 200
    np.testing.assert_allclose(f["y_soh"][0], 1.0 - 0.0015)
    # resistance ratio starts near 1 and grows
    first = np.nanmin(np.nonzero(np.isfinite(f["r_ratio"]))[0])
    assert abs(f["r_ratio"][first] - 1.0) < 0.05  # R0 is the median of the first five readings
    assert f["r_ratio"][-1] > 1.2
    # expanding statistics
    assert f["t_max"][-1] == 30 + 0.01 * 200
    assert f["dis_c_max"][50] == 1.0 and f["dis_c_max"][-1] == 2.0
    # mean discharge voltage change in mV, negative as the cell ages
    assert f["dv_mean_dis"][-1] < -50
    # lifetime fade in points per 100 cycles
    np.testing.assert_allclose(f["fade_life"][99], 0.15, rtol=1e-9)
    # recent fade over the last 50 cycles, same linear rate
    np.testing.assert_allclose(f["fade_recent"][150], 0.15, rtol=0.05)
    assert np.isnan(f["fade_recent"][10])


def test_features_are_causal():
    rec = make_cell()
    f1 = cell_features(rec)
    rec.capacity_ah[120:] *= 0.5
    rec.resistance_ohm[120:] *= 3
    rec.t_max_cycle[120:] += 40
    rec.v_mean_dis[120:] -= 1
    f2 = cell_features(rec)
    for k in ["r_ratio", "t_mean", "t_max", "dv_mean_dis", "fade_recent", "soh_now"]:
        np.testing.assert_array_equal(f1[k][:120], f2[k][:120])


def test_rul_labels():
    cyc = np.arange(1, 11, dtype=float)
    soh = np.array([0.9, 0.88, 0.85, 0.83, 0.81, 0.79, 0.78, 0.7, 0.65, 0.6])
    r = cycles_to_threshold(cyc, soh, 0.8)
    assert r[0] == 5 and r[4] == 1
    assert np.isnan(r[5])  # already below the threshold
    assert np.all(np.isnan(cycles_to_threshold(cyc, soh, 0.5)))  # never reached, censored
